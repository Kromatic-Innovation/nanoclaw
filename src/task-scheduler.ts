import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  getAllRegisteredGroups,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  hasPipeline,
  runPipeline,
  formatPipelineReport,
  getStagePrompt,
} from './pipeline-runner.js';
import {
  runPreflight,
  formatPreflightSlackMessage,
  type PreflightResult,
} from './preflight.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import type { ClassifiedItem, StageCallback } from 'tickle-stick';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Box-claude integration for Tier 2 pipeline processing
// ---------------------------------------------------------------------------

/** Path to the workspace-level box-claude launcher script. */
const BOX_CLAUDE_SCRIPT = path.resolve(
  process.cwd(),
  '..',
  'scripts',
  'claude-container.sh',
);

const BOX_CLAUDE_CONCURRENCY = 6;
const BOX_CLAUDE_MAX_RETRIES = 2;
const BOX_CLAUDE_MAX_ITEMS_PER_LANE = 6;

/** Simple concurrency limiter for async tasks. */
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire() {
      if (active >= limit) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      active++;
    },
    release() {
      active--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

interface TaskContext {
  taskId: string;
  repo: string;
  objective: string;
  items: ClassifiedItem[];
  priorContext: {
    sessionSummary: string;
    completedSteps: string[];
    remainingSteps: string[];
    lastCheckpoint: string;
  } | null;
  retryCount: number;
  maxRetries: number;
}

interface CompletionResult {
  status: 'completed' | 'partial' | 'failed';
  summary: string;
  completedSteps: string[];
  remainingSteps: string[];
  artifacts?: {
    prs?: { url: string; state: string; repo: string }[];
    issuesCreated?: { url: string; repo: string }[];
    stagingGreen?: boolean;
  };
  itemResults?: { id: string; action: string; detail: string }[];
}

/** Extract repo slug from a ClassifiedItem's source or metadata. */
function extractRepoSlug(item: ClassifiedItem): string {
  // Prefer metadata.repo if available (set by gather script)
  const metaRepo = (item as { metadata?: Record<string, unknown> }).metadata
    ?.repo as string | undefined;
  if (metaRepo) return metaRepo;

  // Parse from source: "github-issue/Org/repo" or "dependabot/Org/repo"
  const parts = item.source.split('/');
  if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  return item.source;
}

/** Group classified items by repository. */
function groupItemsByRepo(
  items: ClassifiedItem[],
): Map<string, ClassifiedItem[]> {
  const groups = new Map<string, ClassifiedItem[]>();
  for (const item of items) {
    const repo = extractRepoSlug(item);
    const existing = groups.get(repo) || [];
    existing.push(item);
    groups.set(repo, existing);
  }
  return groups;
}

/** Build a per-repo prompt from the raw template and repo-scoped items. */
function buildPerRepoPrompt(
  template: string,
  repoItems: ClassifiedItem[],
): string {
  const itemsJson = JSON.stringify(
    repoItems.map((c) => ({
      id: c.id,
      source: c.source,
      type: c.type,
      summary: c.summary,
      body: c.body,
      classification: c.classification,
      confidence: c.confidence,
    })),
    null,
    2,
  );
  return template.replace('{{items}}', itemsJson);
}

/** Load secrets needed by box-claude from .env / keychain. */
function loadBoxClaudeEnv(): Record<string, string> {
  return readEnvFile([
    'GITHUB_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'HEROKU_API_KEY',
    'SENTRY_AUTH_TOKEN',
    'SENTRY_ORG',
    'SENTRY_BASE_URL',
  ]);
}

/** Spawn a box-claude instance for a single repo and return its result. */
async function runBoxClaude(
  contextDir: string,
  prompt: string,
): Promise<{ exitCode: number; stdout: string }> {
  const secrets = loadBoxClaudeEnv();
  return new Promise((resolve, reject) => {
    const proc = execFile(
      BOX_CLAUDE_SCRIPT,
      ['--context-dir', contextDir, '--print', prompt],
      {
        timeout: 120 * 60 * 1000, // 120 minutes per repo
        maxBuffer: 10 * 1024 * 1024, // 10MB stdout
        env: { ...process.env, ...secrets },
      },
      (err, stdout, stderr) => {
        if (stderr) {
          logger.warn({ stderr: stderr.slice(-1000) }, 'Box-claude stderr');
        }
        if (err && 'code' in err && typeof err.code === 'number') {
          // Non-zero exit — still return the output
          logger.warn(
            { exitCode: err.code, stderr: stderr?.slice(-500) },
            'Box-claude exited with error',
          );
          resolve({ exitCode: err.code, stdout: stdout || '' });
        } else if (err) {
          reject(err);
        } else {
          resolve({ exitCode: 0, stdout: stdout || '' });
        }
      },
    );

    // Log stderr lines as they come
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug({ source: 'box-claude' }, text);
    });
  });
}

/** Read the completion.json written by box-claude, if it exists. */
function readCompletion(contextDir: string): CompletionResult | null {
  const completionPath = path.join(contextDir, 'completion.json');
  if (!fs.existsSync(completionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(completionPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Structured result from a box-claude repo run. */
interface BoxClaudeRepoResult {
  repo: string;
  summary: string;
  completion: CompletionResult | null;
  status: 'completed' | 'partial' | 'failed' | 'crashed' | 'exhausted';
}

/**
 * Run box-claude for a single repo with retry on partial completion.
 * Returns structured result with completion data for rich reporting.
 */
async function runBoxClaudeForRepo(
  repoSlug: string,
  repoItems: ClassifiedItem[],
  promptTemplate: string,
): Promise<BoxClaudeRepoResult> {
  const taskId = `repo-maint-${repoSlug.replace('/', '-')}-${Date.now()}`;
  const contextDir = path.join(DATA_DIR, 'box-claude-tasks', taskId);
  fs.mkdirSync(path.join(contextDir, 'history'), { recursive: true });

  let retryCount = 0;
  let priorContext: TaskContext['priorContext'] = null;

  while (retryCount <= BOX_CLAUDE_MAX_RETRIES) {
    // Write task.json for box-claude to read
    const taskContext: TaskContext = {
      taskId,
      repo: repoSlug,
      objective: `Process maintenance items for ${repoSlug}`,
      items: repoItems,
      priorContext,
      retryCount,
      maxRetries: BOX_CLAUDE_MAX_RETRIES,
    };
    fs.writeFileSync(
      path.join(contextDir, 'task.json'),
      JSON.stringify(taskContext, null, 2),
    );

    // Write the full prompt to a file (too large for CLI args)
    const promptText =
      retryCount === 0
        ? buildPerRepoPrompt(promptTemplate, repoItems)
        : `Previous session for ${repoSlug} was incomplete. ` +
          `Read /workspace/nanoclaw-context/task.json for context on what was already done. ` +
          `Use /occam to finish the delivery process for any in-progress items.`;

    fs.writeFileSync(path.join(contextDir, 'prompt.txt'), promptText);

    // Short prompt tells the agent to read the full instructions from the file
    const cliPrompt =
      retryCount === 0
        ? `Read and follow the instructions in /workspace/nanoclaw-context/prompt.txt — it contains your full assignment for repo maintenance on ${repoSlug}.`
        : `Previous session was incomplete. Read /workspace/nanoclaw-context/task.json and /workspace/nanoclaw-context/prompt.txt, then use /occam to finish the delivery process.`;

    logger.info(
      { repo: repoSlug, retryCount, taskId },
      'Spawning box-claude for repo',
    );

    try {
      const { exitCode, stdout } = await runBoxClaude(contextDir, cliPrompt);

      // Save session history
      fs.writeFileSync(
        path.join(contextDir, 'history', `session-${retryCount}.json`),
        JSON.stringify({
          retryCount,
          exitCode,
          timestamp: new Date().toISOString(),
          stdoutLength: stdout.length,
        }),
      );

      const completion = readCompletion(contextDir);

      if (completion?.status === 'completed') {
        logger.info(
          { repo: repoSlug, taskId },
          'Box-claude completed successfully',
        );
        return {
          repo: repoSlug,
          summary: completion.summary || stdout.slice(-2000),
          completion,
          status: 'completed',
        };
      }

      if (completion?.status === 'failed') {
        logger.warn({ repo: repoSlug, taskId }, 'Box-claude reported failure');
        return {
          repo: repoSlug,
          summary: completion.summary,
          completion,
          status: 'failed',
        };
      }

      if (completion?.status === 'partial') {
        logger.info(
          { repo: repoSlug, retryCount, taskId },
          'Box-claude partial completion, will retry',
        );
        priorContext = {
          sessionSummary: completion.summary,
          completedSteps: completion.completedSteps || [],
          remainingSteps: completion.remainingSteps || [],
          lastCheckpoint: completion.summary,
        };
        retryCount++;
        continue;
      }

      // No completion.json — likely context exhaustion or crash.
      // Treat both zero and non-zero exits the same: retry with prior
      // context so box-claude can pick up where it left off. Items that
      // were already handled will be skipped on the next attempt (the
      // execute prompt checks for existing PRs and completion state).
      if (exitCode !== 0) {
        logger.warn(
          { repo: repoSlug, exitCode, retryCount, taskId },
          'Box-claude exited non-zero without completion.json — will retry',
        );
      } else {
        logger.warn(
          { repo: repoSlug, retryCount, taskId },
          'Box-claude exited 0 but no completion.json — likely context exhaustion',
        );
      }
      priorContext = {
        sessionSummary: `Previous session ended without writing completion status (exit code ${exitCode})`,
        completedSteps: [],
        remainingSteps: ['Check current state and continue'],
        lastCheckpoint: 'Unknown — check GitHub for current state',
      };
      retryCount++;
      continue;
    } catch (err) {
      logger.error(
        { repo: repoSlug, err, taskId },
        'Failed to spawn box-claude',
      );
      return {
        repo: repoSlug,
        summary: err instanceof Error ? err.message : String(err),
        completion: null,
        status: 'failed',
      };
    }
  }

  return {
    repo: repoSlug,
    summary: `gave up after ${BOX_CLAUDE_MAX_RETRIES + 1} attempts`,
    completion: readCompletion(contextDir),
    status: 'exhausted',
  };
}

/**
 * Process Tier 2 via a direct Anthropic API call.
 * No container, no box-claude — just a single API request.
 * Returns the full response including label_actions JSON.
 */
async function processTier2Direct(
  items: ClassifiedItem[],
  prompt: string,
): Promise<string> {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not found — cannot run Tier 2');
  }

  logger.info(
    { itemCount: items.length },
    'Processing Tier 2 via API (daily briefing)',
  );

  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text?: string }[];
  };
  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  logger.info({ outputLength: text.length }, 'Tier 2 API completed');

  return text;
}

/**
 * Execute email drafts from the Tier 2 reasoning output.
 * Parses draft blocks and creates Gmail drafts via the email action guard.
 */
async function executeEmailDrafts(reasoningOutput: string): Promise<void> {
  // Look for draft blocks in the output: Action: draft
  // Format from Tier 2: To: <recipient>, Subject: <subject>, Draft: <text>
  const draftPattern =
    /To:\s*(.+?)\n\s*Subject:\s*(.+?)\n\s*Draft:\s*([\s\S]*?)\n\s*Action:\s*draft/gi;

  let match: RegExpExecArray | null;
  const drafts: { to: string; subject: string; body: string }[] = [];

  while ((match = draftPattern.exec(reasoningOutput)) !== null) {
    drafts.push({
      to: match[1].trim(),
      subject: match[2].trim(),
      body: match[3].trim(),
    });
  }

  if (drafts.length === 0) {
    logger.debug('No email drafts found in Tier 2 output');
    return;
  }

  const guardScript = path.join(
    process.cwd(),
    'scripts',
    'email-action-guard.py',
  );

  for (const draft of drafts) {
    logger.info(
      { to: draft.to, subject: draft.subject },
      'Creating email draft via action guard',
    );

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'python3',
          [
            guardScript,
            'draft-new',
            '--to',
            draft.to,
            '--subject',
            draft.subject,
            '--body',
            draft.body,
          ],
          { timeout: 30000, env: process.env },
          (err, _stdout, stderr) => {
            if (stderr) {
              logger.debug(
                { stderr: stderr.slice(-500) },
                'Draft guard stderr',
              );
            }
            if (err) {
              logger.warn(
                { to: draft.to, err: err.message },
                'Email draft blocked or failed',
              );
              // Don't reject — blocked drafts are expected behavior
              resolve();
            } else {
              logger.info({ to: draft.to }, 'Email draft created');
              resolve();
            }
          },
        );
      });
    } catch (err) {
      logger.warn({ to: draft.to, err }, 'Email draft execution error');
    }
  }
}

/**
 * Process expensive model stage items by spawning per-repo box-claude instances.
 */
async function processTier2ViaBoxClaude(
  items: ClassifiedItem[],
  pipelineName: string,
): Promise<string> {
  const repoGroups = groupItemsByRepo(items);

  // Load prompt template: prefer file-based prompt for plan pipeline,
  // fall back to the first expensive model stage prompt, then a default.
  let promptTemplate: string;
  if (pipelineName === 'repo-maintenance-plan') {
    const promptFile = path.join(process.cwd(), 'prompts', 'plan-writing.md');
    promptTemplate = fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, 'utf-8')
      : getStagePrompt(pipelineName, 'plan') ||
        'Process these items:\n{{items}}';
  } else {
    promptTemplate =
      getStagePrompt(pipelineName, 'execute') ||
      getStagePrompt(pipelineName, 'triage') ||
      'Process these items:\n{{items}}';
  }

  logger.info(
    { repoCount: repoGroups.size, itemCount: items.length },
    'Processing Tier 2 via box-claude',
  );

  // Process repos with concurrency limit
  const repos = Array.from(repoGroups.entries());
  const results: string[] = [];
  const sem = createSemaphore(BOX_CLAUDE_CONCURRENCY);
  const allTasks: Promise<void>[] = [];

  for (const [repoSlug, repoItems] of repos) {
    await sem.acquire();

    const task = (async () => {
      try {
        const result = await runBoxClaudeForRepo(
          repoSlug,
          repoItems,
          promptTemplate,
        );
        results.push(`## ${repoSlug}\n${result.summary}`);
      } finally {
        sem.release();
      }
    })();

    allTasks.push(task);
  }

  await Promise.allSettled(allTasks);

  return results.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Phased repo maintenance pipeline
// ---------------------------------------------------------------------------

type MaintenancePhase = 'preflight' | 'triage' | 'plan' | 'execute';

interface MaintenanceRunConfig {
  phases: MaintenancePhase[];
  repos?: string[];
  concurrency: number;
  executionTimeout_ms: number;
}

interface Lane {
  id: string;
  type: 'single-repo' | 'multi-repo';
  repos: string[];
  items: ClassifiedItem[];
  workingDir: string;
  timeout_ms: number;
}

interface PhaseResult {
  phase: MaintenancePhase | 'complete';
  status: 'success' | 'partial' | 'failed';
  duration_ms: number;
  summary: string;
}

const REPOS_JSON_PATH = path.join(
  process.cwd(),
  'groups',
  'global',
  'repos.json',
);

/** Load repos.json for path lookups. */
function loadReposJson(): { path: string; owner: string; repo: string }[] {
  try {
    return JSON.parse(fs.readFileSync(REPOS_JSON_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

/** Find the common parent project directory for multi-repo lanes. */
function findCommonParent(repoPaths: string[]): string {
  if (repoPaths.length <= 1) return repoPaths[0] || process.cwd();
  const parts = repoPaths.map((p) => p.split('/'));
  let common = '';
  for (let i = 0; i < parts[0].length; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) {
      common += (common ? '/' : '') + segment;
    } else break;
  }
  return common || process.cwd();
}

/**
 * Detect cross-repo dependencies by scanning issue bodies for references
 * to issues in other repos within the same run.
 */
function detectCrossRepoDeps(
  repoGroups: Map<string, ClassifiedItem[]>,
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  const allRepos = new Set(repoGroups.keys());

  for (const [repo, items] of repoGroups) {
    for (const item of items) {
      const body = item.body || '';
      // Only match explicit issue/PR references: "owner/repo#123" or "repo#123"
      for (const otherRepo of allRepos) {
        if (otherRepo === repo) continue;
        const [, repoName] = otherRepo.split('/');
        // Match "repo#digits" or "owner/repo#digits" — not just the repo name in text
        const refPattern = new RegExp(
          `(?:${otherRepo.replace('/', '\\/')}|${repoName})#\\d+`,
        );
        if (refPattern.test(body)) {
          if (!deps.has(repo)) deps.set(repo, new Set());
          deps.get(repo)!.add(otherRepo);
        }
      }
    }
  }
  return deps;
}

/**
 * Build lanes from classified items, handling cross-repo dependencies.
 */
function buildLanes(
  items: ClassifiedItem[],
  config: MaintenanceRunConfig,
): Lane[] {
  const repoGroups = groupItemsByRepo(items);
  const crossRepoDeps = detectCrossRepoDeps(repoGroups);
  const repos = loadReposJson();
  const workspace = path.resolve(process.cwd(), '..');

  // Group repos with cross-dependencies into multi-repo lanes
  const assigned = new Set<string>();
  const lanes: Lane[] = [];

  for (const [repo, repoItems] of repoGroups) {
    if (assigned.has(repo)) continue;

    const deps = crossRepoDeps.get(repo);
    if (deps && deps.size > 0) {
      // Multi-repo lane: include all repos in the dependency cluster
      const clusterRepos = [repo, ...deps];
      const clusterItems: ClassifiedItem[] = [];
      const repoPaths: string[] = [];

      for (const r of clusterRepos) {
        assigned.add(r);
        const group = repoGroups.get(r);
        if (group) clusterItems.push(...group);
        const repoEntry = repos.find((e) => `${e.owner}/${e.repo}` === r);
        if (repoEntry) repoPaths.push(path.join(workspace, repoEntry.path));
      }

      const commonParent = findCommonParent(repoPaths);
      lanes.push({
        id: `multi-${clusterRepos.map((r) => r.split('/')[1]).join('-')}-${Date.now()}`,
        type: 'multi-repo',
        repos: clusterRepos,
        items: clusterItems,
        workingDir: commonParent,
        timeout_ms: config.executionTimeout_ms,
      });
    } else {
      // Single-repo lane
      assigned.add(repo);
      const repoEntry = repos.find((e) => `${e.owner}/${e.repo}` === repo);
      const repoPath = repoEntry
        ? path.join(workspace, repoEntry.path)
        : workspace;

      lanes.push({
        id: `single-${repo.replace('/', '-')}-${Date.now()}`,
        type: 'single-repo',
        repos: [repo],
        items: repoItems,
        workingDir: repoPath,
        timeout_ms: config.executionTimeout_ms,
      });
    }
  }

  // Split oversized lanes into chunks of BOX_CLAUDE_MAX_ITEMS_PER_LANE
  const splitLanes: Lane[] = [];
  for (const lane of lanes) {
    if (lane.items.length <= BOX_CLAUDE_MAX_ITEMS_PER_LANE) {
      splitLanes.push(lane);
    } else {
      for (
        let i = 0;
        i < lane.items.length;
        i += BOX_CLAUDE_MAX_ITEMS_PER_LANE
      ) {
        const chunk = lane.items.slice(i, i + BOX_CLAUDE_MAX_ITEMS_PER_LANE);
        const chunkIndex = Math.floor(i / BOX_CLAUDE_MAX_ITEMS_PER_LANE) + 1;
        splitLanes.push({
          ...lane,
          id: `${lane.id}-chunk${chunkIndex}`,
          items: chunk,
        });
      }
    }
  }

  return splitLanes;
}

/** Run cleanup scripts for repos after a lane completes. */
async function runPostLaneCleanup(lane: Lane): Promise<void> {
  const cleanupScript = path.resolve(
    process.cwd(),
    '..',
    'scripts',
    'repo_cleanup_triage.sh',
  );

  for (const repoPath of lane.repos.map((r) => {
    const repos = loadReposJson();
    const entry = repos.find((e) => `${e.owner}/${e.repo}` === r);
    return entry
      ? path.join(path.resolve(process.cwd(), '..'), entry.path)
      : null;
  })) {
    if (!repoPath) continue;
    try {
      await new Promise<void>((resolve) => {
        execFile(
          cleanupScript,
          ['--repo-path', repoPath, '--mode', 'cleanup', '--apply'],
          { timeout: 60_000 },
          (err) => {
            if (err) logger.warn({ err, repoPath }, 'Post-lane cleanup error');
            resolve();
          },
        );
      });
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Parse pipeline:repo-maintenance command with optional flags. */
function parseMaintenancePrompt(prompt: string): MaintenanceRunConfig {
  const defaultConfig: MaintenanceRunConfig = {
    phases: ['preflight', 'triage', 'plan', 'execute'],
    concurrency: BOX_CLAUDE_CONCURRENCY,
    executionTimeout_ms: 120 * 60 * 1000, // 120 minutes
  };

  // Parse --phases flag
  const phasesMatch = prompt.match(/--phases\s+(\S+)/);
  if (phasesMatch) {
    defaultConfig.phases = phasesMatch[1].split(',') as MaintenancePhase[];
  }

  // Parse --repos flag
  const reposMatch = prompt.match(/--repos\s+(\S+)/);
  if (reposMatch) {
    defaultConfig.repos = reposMatch[1].split(',');
  }

  return defaultConfig;
}

/**
 * Run the full phased maintenance pipeline.
 * Phases: preflight → triage → plan → execute → report
 */
async function runMaintenancePipeline(
  prompt: string,
  deps: SchedulerDependencies,
  chatJid: string,
): Promise<string> {
  const config = parseMaintenancePrompt(prompt);
  const results: PhaseResult[] = [];
  let classifiedItems: ClassifiedItem[] = [];
  let humanItems: ClassifiedItem[] = [];

  // ── Phase: Preflight ──────────────────────────────────────────────────
  if (config.phases.includes('preflight')) {
    const phaseStart = Date.now();
    await deps.sendMessage(
      chatJid,
      `Starting daily run. Cleaning up${config.repos ? ` ${config.repos.join(', ')}` : ' all repos'}...`,
    );

    try {
      const preflightResult = await runPreflight({ repos: config.repos });
      const msg = formatPreflightSlackMessage(preflightResult);
      await deps.sendMessage(chatJid, msg);
      results.push({
        phase: 'preflight',
        status: 'success',
        duration_ms: Date.now() - phaseStart,
        summary: msg.split('\n')[0],
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Preflight phase failed');
      await deps.sendMessage(chatJid, `Preflight failed: ${error}`);
      results.push({
        phase: 'preflight',
        status: 'failed',
        duration_ms: Date.now() - phaseStart,
        summary: `Failed: ${error}`,
      });
    }
  }

  // ── Phase: Triage ─────────────────────────────────────────────────────
  if (config.phases.includes('triage')) {
    const phaseStart = Date.now();
    await deps.sendMessage(chatJid, 'Triage starting...');

    try {
      // Pass --repos to the gather script for pre-triage filtering
      const extraScriptArgs = config.repos?.length
        ? ['--repos', config.repos.join(',')]
        : undefined;

      const triageResult = await runPipeline(
        'repo-maintenance-triage',
        {
          // triage stage: summarize escalated items (no execution here)
          triage: async (items) => {
            const repoGroups = groupItemsByRepo(items);
            const summary = Array.from(repoGroups.entries())
              .map(([repo, repoItems]) => `${repo}: ${repoItems.length} items`)
              .join(', ');
            return `${items.length} items escalated across ${repoGroups.size} repos: ${summary}`;
          },
          // escalate stage: send items needing human attention
          escalate: async (items) => {
            humanItems = items;
            const msg = items
              .map((i) => `[${i.source}] ${i.summary}`)
              .join('\n');
            await deps.sendMessage(
              chatJid,
              `Items needing human attention:\n${msg}`,
            );
            return '';
          },
        },
        {
          extraScriptArgs,
          // Capture classified items via onStageComplete
          onStageComplete: (name, stageResult) => {
            if (name === 'classify') {
              classifiedItems = stageResult.items as ClassifiedItem[];
            }
          },
        },
      );

      const classifyStage = triageResult.stageResults.find(
        (s) => s.name === 'classify',
      );
      const triageStage = triageResult.stageResults.find(
        (s) => s.name === 'triage',
      );
      const triageSummary = `Triage complete. ${triageResult.totalItems} items found: ${classifyStage?.items.length ?? 0} classified, ${triageStage?.items.length ?? 0} for processing`;
      await deps.sendMessage(chatJid, triageSummary);
      results.push({
        phase: 'triage',
        status: 'success',
        duration_ms: Date.now() - phaseStart,
        summary: triageSummary,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Triage phase failed');
      await deps.sendMessage(chatJid, `Triage failed: ${error}`);
      results.push({
        phase: 'triage',
        status: 'failed',
        duration_ms: Date.now() - phaseStart,
        summary: `Failed: ${error}`,
      });
      // Can't continue without triage data
      return formatFinalReport(results);
    }
  }

  // ── Phase: Plan ───────────────────────────────────────────────────────
  if (config.phases.includes('plan') && classifiedItems.length > 0) {
    const phaseStart = Date.now();
    // Items that need plans: needs-reasoning without existing plans
    const needsPlan = classifiedItems.filter(
      (item) =>
        item.classification === 'needs-reasoning' &&
        !(item as { metadata?: Record<string, unknown> }).metadata
          ?.hasExistingPlan,
    );

    if (needsPlan.length > 0) {
      await deps.sendMessage(
        chatJid,
        `Planning ${needsPlan.length} items that need implementation plans...`,
      );

      // Spawn box-claude instances for planning (per repo)
      const planReport = await processTier2ViaBoxClaude(
        needsPlan,
        'repo-maintenance-plan',
      );

      const planSummary = `Planning complete. ${needsPlan.length} items processed.`;
      await deps.sendMessage(chatJid, planSummary);
      results.push({
        phase: 'plan',
        status: 'success',
        duration_ms: Date.now() - phaseStart,
        summary: planSummary,
      });
    } else {
      results.push({
        phase: 'plan',
        status: 'success',
        duration_ms: 0,
        summary: 'No items need planning.',
      });
    }
  }

  // ── Phase: Execute ────────────────────────────────────────────────────
  if (config.phases.includes('execute') && classifiedItems.length > 0) {
    const phaseStart = Date.now();
    // Items ready for execution: routine + urgent + approved items
    const readyForExecution = classifiedItems.filter((item) => {
      const labels =
        ((item as { metadata?: Record<string, unknown> }).metadata
          ?.labels as string[]) || [];
      const isApproved = labels.includes('status:approved');
      return (
        item.classification === 'routine' ||
        item.classification === 'urgent' ||
        isApproved
      );
    });

    if (readyForExecution.length > 0) {
      const lanes = buildLanes(readyForExecution, config);
      const laneDescriptions = lanes
        .map(
          (l) =>
            `${l.type === 'multi-repo' ? 'Multi' : 'Lane'} (${l.repos.join(' + ')}: ${l.items.length} items)`,
        )
        .join(', ');
      await deps.sendMessage(
        chatJid,
        `Execution starting. ${lanes.length} lanes: ${laneDescriptions}`,
      );

      // Execute lanes with concurrency limit
      const laneResults: BoxClaudeRepoResult[] = [];
      const laneSem = createSemaphore(config.concurrency);
      const lanePromises: Promise<void>[] = [];

      for (const lane of lanes) {
        await laneSem.acquire();

        const laneTask = (async () => {
          try {
            const promptTemplate =
              getStagePrompt('repo-maintenance-execute', 'execute') ||
              'Process these items:\n{{items}}';

            // For multi-repo lanes, combine all items into one prompt
            const result =
              lane.type === 'multi-repo'
                ? await runBoxClaudeForRepo(
                    lane.repos.join('+'),
                    lane.items,
                    promptTemplate,
                  )
                : await runBoxClaudeForRepo(
                    lane.repos[0],
                    lane.items,
                    promptTemplate,
                  );

            laneResults.push(result);

            // Post-lane cleanup
            await runPostLaneCleanup(lane);

            // Per-lane Slack update: send rich per-lane report
            const laneReport = formatLaneReport(result);
            await deps.sendMessage(chatJid, laneReport);
          } finally {
            laneSem.release();
          }
        })();

        lanePromises.push(laneTask);
      }

      await Promise.allSettled(lanePromises);

      const fixedCount = laneResults.reduce(
        (n, r) =>
          n +
          (r.completion?.itemResults?.filter((i) => i.action === 'fixed')
            .length ?? 0),
        0,
      );
      const skippedCount = laneResults.reduce(
        (n, r) =>
          n +
          (r.completion?.itemResults?.filter((i) => i.action !== 'fixed')
            .length ?? 0),
        0,
      );
      const prCount = laneResults.reduce(
        (n, r) => n + (r.completion?.artifacts?.prs?.length ?? 0),
        0,
      );
      const execSummary = `Execution complete. ${lanes.length} lane(s): ${fixedCount} fixed (${prCount} PRs), ${skippedCount} skipped/blocked.`;
      results.push({
        phase: 'execute',
        status: 'success',
        duration_ms: Date.now() - phaseStart,
        summary: execSummary,
      });
    } else {
      await deps.sendMessage(chatJid, 'No items ready for execution.');
      results.push({
        phase: 'execute',
        status: 'success',
        duration_ms: 0,
        summary: 'No items ready for execution.',
      });
    }
  }

  // ── Final Report ──────────────────────────────────────────────────────
  const finalReport = formatFinalReport(results);
  await deps.sendMessage(chatJid, finalReport);
  return finalReport;
}

/** Format a rich per-lane report from box-claude completion data. */
function formatLaneReport(result: BoxClaudeRepoResult): string {
  const lines: string[] = [`Maintenance complete (${result.repo}):`];
  const items = result.completion?.itemResults ?? [];

  if (items.length === 0) {
    lines.push(result.summary);
    return lines.join('\n');
  }

  const fixed = items.filter((i) => i.action === 'fixed');
  const blocked = items.filter(
    (i) =>
      i.action === 'skipped' && /block|depend|missing|await/i.test(i.detail),
  );
  const skipped = items.filter(
    (i) => i.action === 'skipped' && !blocked.includes(i),
  );
  const failed = items.filter((i) => i.action === 'failed');

  // Extract issue number from item ID (e.g., "planned-fix-Org-repo-123" → "#123")
  const issueRef = (id: string): string => {
    const m = id.match(/-(\d+)$/);
    return m ? `#${m[1]}` : id;
  };

  // Extract short detail (first sentence or up to 80 chars)
  const shortDetail = (detail: string): string => {
    const first = detail.split(/\.\s/)[0];
    return first.length > 80 ? first.slice(0, 77) + '...' : first;
  };

  if (fixed.length > 0) {
    lines.push('', `Fixed (${fixed.length}):`);
    // Collect PR URLs for reference
    const prs = result.completion?.artifacts?.prs ?? [];
    for (const item of fixed) {
      const pr = prs.find((p) =>
        item.detail.includes(p.url.split('/').pop() ?? ''),
      );
      const prRef = pr ? ` — ${pr.url}` : '';
      lines.push(`• ${issueRef(item.id)} ${shortDetail(item.detail)}${prRef}`);
    }
    if (result.completion?.artifacts?.stagingGreen) {
      lines.push('  ✓ staging green');
    }
  }

  if (blocked.length > 0) {
    lines.push('', `Blocked (${blocked.length}):`);
    for (const item of blocked) {
      const url = itemIdToUrl(result.repo, item.id);
      const urlLine = url ? `\n  → ${url}` : '';
      lines.push(
        `• ${issueRef(item.id)} ${shortDetail(item.detail)}${urlLine}`,
      );
    }
  }

  if (skipped.length > 0) {
    lines.push('', `Skipped (${skipped.length}):`);
    for (const item of skipped) {
      lines.push(`• ${issueRef(item.id)} ${shortDetail(item.detail)}`);
    }
  }

  if (failed.length > 0) {
    lines.push('', `Failed (${failed.length}):`);
    for (const item of failed) {
      const url = itemIdToUrl(result.repo, item.id);
      const urlLine = url ? `\n  → ${url}` : '';
      lines.push(
        `• ${issueRef(item.id)} ${shortDetail(item.detail)}${urlLine}`,
      );
    }
  }

  return lines.join('\n');
}

/** Build a GitHub issue URL from an item ID and the known repo slug. */
function itemIdToUrl(repoSlug: string, itemId: string): string | undefined {
  const issueNum = itemId.match(/-(\d+)$/)?.[1];
  if (!issueNum) return undefined;
  if (itemId.startsWith('dependabot-')) {
    return `https://github.com/${repoSlug}/security/dependabot/${issueNum}`;
  }
  return `https://github.com/${repoSlug}/issues/${issueNum}`;
}

/** Format the final summary across all phases. */
function formatFinalReport(results: PhaseResult[]): string {
  const lines = ['Daily maintenance run complete:'];
  for (const r of results) {
    const duration =
      r.duration_ms > 0 ? ` (${(r.duration_ms / 1000).toFixed(0)}s)` : '';
    const icon =
      r.status === 'success'
        ? ''
        : r.status === 'partial'
          ? ' [PARTIAL]'
          : ' [FAILED]';
    lines.push(`- ${r.phase}${icon}${duration}: ${r.summary}`);
  }
  return lines.join('\n');
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // --- Pipeline tasks: bypass container, run through tickle-stick ---
  if (task.prompt.startsWith('pipeline:')) {
    const pipelinePrompt = task.prompt.slice('pipeline:'.length).trim();

    // Acknowledge pipeline start
    const pipelineLabel = pipelinePrompt.split(' ')[0];
    const startMsg =
      pipelineLabel === 'daily-briefing'
        ? "I'm putting together your daily briefing now…"
        : `Starting pipeline: *${pipelineLabel}* …`;
    await deps.sendMessage(task.chat_jid, startMsg).catch(() => {});

    // Repo maintenance uses the phased orchestrator
    if (
      pipelinePrompt === 'repo-maintenance' ||
      pipelinePrompt.startsWith('repo-maintenance ')
    ) {
      try {
        result = await runMaintenancePipeline(
          pipelinePrompt,
          deps,
          task.chat_jid,
        );
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error({ taskId: task.id, error }, 'Maintenance pipeline failed');
      }
    } else if (!hasPipeline(pipelinePrompt)) {
      error = `Pipeline not found: ${pipelinePrompt}`;
      logger.error({ taskId: task.id, pipelineName: pipelinePrompt }, error);
    } else {
      // Other pipelines (daily-briefing, weekly-retro) use standard flow
      try {
        const isDailyBriefing = pipelinePrompt === 'daily-briefing';

        // Build stage callbacks based on pipeline type
        const stageCallbacks: Record<string, StageCallback> = {};

        if (isDailyBriefing) {
          // Daily briefing: direct API calls for reasoning and synthesis
          stageCallbacks['reason'] = async (items, prompt) => {
            return processTier2Direct(items, prompt);
          };
          stageCallbacks['synthesize'] = async (items, prompt) => {
            return processTier2Direct(items, prompt);
          };
          // Post-deliver: apply claw/triaged labels after briefing is sent
          stageCallbacks['post-deliver'] = async (items) => {
            try {
              await applyTriagedLabels(items);
            } catch (labelErr) {
              logger.warn(
                { err: labelErr },
                'Failed to apply post-delivery triaged labels',
              );
            }
            return '';
          };
        } else {
          // Weekly retro and other pipelines: use box-claude for expensive stages
          stageCallbacks['synthesize'] = async (items, prompt) => {
            return processTier2Direct(items, prompt);
          };
          stageCallbacks['escalate'] = async (items) => {
            const msg = items
              .map((i) => `[${i.source}] ${i.summary}`)
              .join('\n');
            await deps.sendMessage(
              task.chat_jid,
              `Items needing human attention:\n${msg}`,
            );
            return '';
          };
        }

        const pipelineResult = await runPipeline(
          pipelinePrompt,
          stageCallbacks,
        );

        if (isDailyBriefing) {
          // The briefing is the clean output of the "synthesize" stage
          const synthesizeStage = pipelineResult.stageResults.find(
            (s) => s.name === 'synthesize',
          );
          const briefing = synthesizeStage?.output?.trim();

          result =
            pipelineResult.totalItems === 0
              ? 'No new items found — inbox is clear.'
              : briefing || 'No items needed attention today.';
          await deps.sendMessage(task.chat_jid, result);
        } else {
          result = formatPipelineReport(pipelineResult);
          if (result) {
            await deps.sendMessage(task.chat_jid, result);
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error(
          { taskId: task.id, pipelineName: pipelinePrompt, error },
          'Pipeline failed',
        );
      }
    }

    // Notify user of pipeline errors
    if (error) {
      await deps
        .sendMessage(
          task.chat_jid,
          `Pipeline *${pipelineLabel}* failed: ${error}`,
        )
        .catch(() => {});
    }

    const durationMs = Date.now() - startTime;
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result,
      error,
    });
    const nextRun = computeNextRun(task);
    const resultSummary = error
      ? `Error: ${error}`
      : result
        ? result.slice(0, 200)
        : 'Completed';
    updateTaskAfterRun(task.id, nextRun, resultSummary);
    return;
  }

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

// ---------------------------------------------------------------------------
// Startup sync: ensure scheduled repo maintenance tasks exist from config
// ---------------------------------------------------------------------------

const DAY_CRON_MAP: Record<string, { cron: string; dayNum: number }> = {
  monday: { cron: '1 0 * * 1', dayNum: 1 },
  tuesday: { cron: '1 0 * * 2', dayNum: 2 },
  wednesday: { cron: '1 0 * * 3', dayNum: 3 },
  thursday: { cron: '1 0 * * 4', dayNum: 4 },
  friday: { cron: '1 0 * * 5', dayNum: 5 },
  saturday: { cron: '1 0 * * 6', dayNum: 6 },
  sunday: { cron: '1 0 * * 0', dayNum: 0 },
};

/**
 * Sync scheduled repo maintenance tasks from config/private.yaml.
 *
 * For each day in repoMaintenance.scheduledRepos, ensures a cron task
 * exists with the right repos. Creates missing tasks, updates prompts
 * if the repo list changed, and leaves existing matching tasks alone.
 */
function syncScheduledRepoMaintenance(): void {
  const configPath = path.join(process.cwd(), 'config', 'private.yaml');
  if (!fs.existsSync(configPath)) {
    logger.debug('No config/private.yaml found, skipping scheduled repo sync');
    return;
  }

  let config: {
    repoMaintenance?: {
      dailyRepos?: string[];
      scheduledRepos?: Record<string, string[]>;
    };
  };
  try {
    config = parseYaml(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    logger.warn(
      { err },
      'Failed to parse config/private.yaml for scheduled repo sync',
    );
    return;
  }

  const dailyRepos = config?.repoMaintenance?.dailyRepos;
  const scheduledRepos = config?.repoMaintenance?.scheduledRepos;
  if (
    (!scheduledRepos || Object.keys(scheduledRepos).length === 0) &&
    (!dailyRepos || dailyRepos.length === 0)
  ) {
    logger.debug('No dailyRepos or scheduledRepos in config, skipping sync');
    return;
  }

  // Find the main group's JID for task ownership
  const groups = getAllRegisteredGroups();
  let mainJid: string | null = null;
  let mainFolder: string | null = null;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) {
      mainJid = jid;
      mainFolder = group.folder;
      break;
    }
  }
  if (!mainJid || !mainFolder) {
    logger.warn('No main group registered yet, deferring scheduled repo sync');
    return;
  }

  const existingTasks = getAllTasks();
  const existingById = new Map(existingTasks.map((t) => [t.id, t]));

  // --- Daily repos: single cron task running every day at 12:01 AM ---
  if (dailyRepos && dailyRepos.length > 0) {
    const taskId = 'repo-maint-daily';
    const repoList = dailyRepos.join(',');
    const prompt = `pipeline:repo-maintenance --repos ${repoList}`;
    const cronExpr = '1 0 * * *'; // 12:01 AM every day

    const existing = existingById.get(taskId);
    if (existing) {
      if (existing.prompt !== prompt) {
        updateTask(taskId, { prompt });
        logger.info(
          { taskId, repos: dailyRepos.length },
          'Updated daily repo maintenance task (repo list changed)',
        );
      }
      if (existing.status !== 'active') {
        updateTask(taskId, { status: 'active' });
      }
    } else {
      const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();

      createTask({
        id: taskId,
        group_folder: mainFolder,
        chat_jid: mainJid,
        prompt,
        schedule_type: 'cron',
        schedule_value: cronExpr,
        context_mode: 'isolated',
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      logger.info(
        { taskId, repos: dailyRepos.length, nextRun },
        'Created daily repo maintenance task',
      );
    }
  }

  // --- Per-day scheduled repos: one cron task per weekday ---
  if (!scheduledRepos || Object.keys(scheduledRepos).length === 0) return;

  for (const [day, repos] of Object.entries(scheduledRepos)) {
    const dayLower = day.toLowerCase();
    const dayInfo = DAY_CRON_MAP[dayLower];
    if (!dayInfo || !Array.isArray(repos) || repos.length === 0) continue;

    const taskId = `repo-maint-scheduled-${dayLower}`;
    const repoList = repos.join(',');
    const prompt = `pipeline:repo-maintenance --repos ${repoList}`;

    const existing = existingById.get(taskId);
    if (existing) {
      // Update prompt if repo list changed
      if (existing.prompt !== prompt) {
        updateTask(taskId, { prompt });
        logger.info(
          { taskId, day: dayLower, repos: repos.length },
          'Updated scheduled repo maintenance task (repo list changed)',
        );
      }
      // Re-activate if it was paused/completed
      if (existing.status !== 'active') {
        updateTask(taskId, { status: 'active' });
      }
      continue;
    }

    // Compute first next_run from the cron expression
    const interval = CronExpressionParser.parse(dayInfo.cron, { tz: TIMEZONE });
    const nextRun = interval.next().toISOString();

    createTask({
      id: taskId,
      group_folder: mainFolder,
      chat_jid: mainJid,
      prompt,
      schedule_type: 'cron',
      schedule_value: dayInfo.cron,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info(
      { taskId, day: dayLower, repos: repos.length, nextRun },
      'Created scheduled repo maintenance task',
    );
  }
}

// ---------------------------------------------------------------------------
// Post-pipeline: apply Gmail labels for email triage dedup
// ---------------------------------------------------------------------------

const GMAIL_WRAPPER_PATH =
  process.env.GMAIL_WRAPPER_PATH ||
  path.join(
    os.homedir(),
    '.openclaw',
    'workspace',
    'scripts',
    'gmail_wrapper.py',
  );

const EMAIL_ACTION_GUARD_PATH = path.join(
  process.cwd(),
  'scripts',
  'email-action-guard.py',
);

/**
 * Parse Tier 2 output for label_actions JSON and apply Gmail labels.
 *
 * Expects a JSON block in the pipeline result like:
 * ```json
 * {"label_actions": [{"messageId": "abc", "label": "claw/triaged"}]}
 * ```
 */
async function applyEmailTriageLabels(pipelineResult: string): Promise<void> {
  // Extract JSON block from the result
  const jsonMatch = pipelineResult.match(
    /\{[\s\S]*?"label_actions"\s*:\s*\[[\s\S]*?\]\s*\}/,
  );
  if (!jsonMatch) {
    logger.debug('No label_actions found in pipeline result');
    return;
  }

  let labelActions: { messageId: string; label: string }[];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    labelActions = parsed.label_actions;
  } catch {
    logger.warn('Failed to parse label_actions JSON from pipeline result');
    return;
  }

  if (!Array.isArray(labelActions) || labelActions.length === 0) return;

  // Ensure claw/* labels exist (create once, errors are fine if they exist)
  const uniqueLabels = [...new Set(labelActions.map((a) => a.label))];
  for (const label of uniqueLabels) {
    try {
      execFile('python3', [
        GMAIL_WRAPPER_PATH,
        'label-create',
        '--name',
        label,
      ]);
    } catch {
      // Label likely already exists
    }
  }

  // Apply labels via the action guard (safety net)
  const wrapperScript = fs.existsSync(EMAIL_ACTION_GUARD_PATH)
    ? EMAIL_ACTION_GUARD_PATH
    : GMAIL_WRAPPER_PATH;

  let applied = 0;
  for (const action of labelActions) {
    if (!action.messageId || !action.label) continue;
    // Strip "gmail-" prefix if the model used the WorkItem ID instead of the raw Gmail ID
    if (action.messageId.startsWith('gmail-')) {
      action.messageId = action.messageId.slice(6);
    }
    // Only allow claw/* labels in this automated step
    if (
      !action.label.startsWith('claw/') &&
      !action.label.startsWith('claw-')
    ) {
      logger.warn(
        { label: action.label },
        'Skipping non-claw label in post-pipeline step',
      );
      continue;
    }

    try {
      const result = await new Promise<void>((resolve, reject) => {
        execFile(
          'python3',
          [
            wrapperScript,
            'label-add',
            '--id',
            action.messageId,
            '--labels',
            action.label,
          ],
          { timeout: 15000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
      applied++;
    } catch (err) {
      logger.warn(
        { messageId: action.messageId, label: action.label, err },
        'Failed to apply email label',
      );
    }
  }

  if (applied > 0) {
    logger.info(
      { applied, total: labelActions.length },
      'Applied post-pipeline email labels',
    );
  }
}

/**
 * Apply claw/triaged labels to all gmail items after successful briefing delivery.
 * This is called from the "post-deliver" callback stage.
 */
async function applyTriagedLabels(
  items: (import('tickle-stick').WorkItem | ClassifiedItem)[],
): Promise<void> {
  const gmailIds = items
    .filter((i) => i.source === 'gmail' && i.id.startsWith('gmail-'))
    .map((i) => i.id.slice(6));

  if (gmailIds.length === 0) return;

  try {
    await applyEmailTriageLabels(
      JSON.stringify({
        label_actions: gmailIds.map((id) => ({
          messageId: id,
          label: 'claw/triaged',
        })),
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to apply triaged labels');
  }
}

/**
 * Sync the daily briefing task from config/private.yaml.
 *
 * Reads dailyBriefing.enabled and dailyBriefing.cron, then creates or
 * updates a cron task for the daily-briefing pipeline.
 */
function syncDailyBriefing(): void {
  const configPath = path.join(process.cwd(), 'config', 'private.yaml');
  if (!fs.existsSync(configPath)) return;

  let config: {
    dailyBriefing?: {
      enabled?: boolean;
      cron?: string;
    };
  };
  try {
    config = parseYaml(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    logger.warn(
      { err },
      'Failed to parse config/private.yaml for daily briefing sync',
    );
    return;
  }

  const briefingConfig = config?.dailyBriefing;
  if (!briefingConfig?.enabled) {
    logger.debug('Daily briefing not enabled in config, skipping sync');
    return;
  }

  const groups = getAllRegisteredGroups();
  let mainJid: string | null = null;
  let mainFolder: string | null = null;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) {
      mainJid = jid;
      mainFolder = group.folder;
      break;
    }
  }
  if (!mainJid || !mainFolder) {
    logger.warn('No main group registered yet, deferring daily briefing sync');
    return;
  }

  const taskId = 'daily-briefing';
  const cronExpr = briefingConfig.cron || '0 6 * * *';
  const prompt = 'pipeline:daily-briefing';

  const existingTasks = getAllTasks();
  const existing = existingTasks.find((t) => t.id === taskId);

  if (existing) {
    // Update cron if changed
    if (existing.schedule_value !== cronExpr) {
      const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      updateTask(taskId, { schedule_value: cronExpr, next_run: nextRun });
      logger.info(
        { taskId, cron: cronExpr, nextRun },
        'Updated daily briefing schedule',
      );
    }
    if (existing.status !== 'active') {
      updateTask(taskId, { status: 'active' });
    }
    return;
  }

  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  const nextRun = interval.next().toISOString();

  createTask({
    id: taskId,
    group_folder: mainFolder,
    chat_jid: mainJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { taskId, cron: cronExpr, nextRun },
    'Created daily briefing task',
  );
}

function syncWeeklyRetro(): void {
  const configPath = path.join(process.cwd(), 'config', 'private.yaml');
  if (!fs.existsSync(configPath)) return;

  let config: { weeklyRetro?: { enabled?: boolean; cron?: string } };
  try {
    config = parseYaml(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return;
  }

  const retroConfig = config?.weeklyRetro;
  if (!retroConfig?.enabled) return;

  const groups = getAllRegisteredGroups();
  let mainJid: string | null = null;
  let mainFolder: string | null = null;
  for (const [jid, group] of Object.entries(groups)) {
    if (group.isMain) {
      mainJid = jid;
      mainFolder = group.folder;
      break;
    }
  }
  if (!mainJid || !mainFolder) return;

  const taskId = 'weekly-retro';
  const cronExpr = retroConfig.cron || '0 18 * * 5';
  const prompt = 'pipeline:weekly-retro';

  const existingTasks = getAllTasks();
  const existing = existingTasks.find((t) => t.id === taskId);

  if (existing) {
    if (existing.schedule_value !== cronExpr) {
      const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      updateTask(taskId, { schedule_value: cronExpr, next_run: nextRun });
      logger.info(
        { taskId, cron: cronExpr, nextRun },
        'Updated weekly retro schedule',
      );
    }
    if (existing.status !== 'active') {
      updateTask(taskId, { status: 'active' });
    }
    return;
  }

  const interval = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE });
  const nextRun = interval.next().toISOString();

  createTask({
    id: taskId,
    group_folder: mainFolder,
    chat_jid: mainJid,
    prompt,
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info({ taskId, cron: cronExpr, nextRun }, 'Created weekly retro task');
}

let schedulerRunning = false;

/** Saved deps for on-demand pipeline triggers. */
let savedSchedulerDeps: SchedulerDependencies | null = null;

/**
 * Trigger a pipeline on demand (e.g. from a Slack message).
 * Creates a one-shot task and immediately enqueues it.
 */
export function triggerPipelineNow(
  pipelinePrompt: string,
  chatJid: string,
  groupFolder: string,
): boolean {
  if (!savedSchedulerDeps) return false;

  const taskId = `on-demand-${Date.now()}`;
  const now = new Date().toISOString();

  createTask({
    id: taskId,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: `pipeline:${pipelinePrompt}`,
    schedule_type: 'once',
    schedule_value: now,
    context_mode: 'isolated',
    next_run: now,
    status: 'active',
    created_at: now,
  });

  const task: ScheduledTask = {
    id: taskId,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: `pipeline:${pipelinePrompt}`,
    schedule_type: 'once',
    schedule_value: now,
    context_mode: 'isolated',
    next_run: now,
    status: 'active',
    created_at: now,
    last_run: null as unknown as string,
    last_result: null as unknown as string,
  };

  savedSchedulerDeps.queue.enqueueTask(chatJid, taskId, () =>
    runTask(task, savedSchedulerDeps!),
  );

  return true;
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  savedSchedulerDeps = deps;

  // Sync config-driven scheduled tasks before starting the poll loop
  try {
    syncScheduledRepoMaintenance();
  } catch (err) {
    logger.error({ err }, 'Failed to sync scheduled repo maintenance tasks');
  }

  try {
    syncDailyBriefing();
  } catch (err) {
    logger.error({ err }, 'Failed to sync daily briefing task');
  }

  try {
    syncWeeklyRetro();
  } catch (err) {
    logger.error({ err }, 'Failed to sync weekly retro task');
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
