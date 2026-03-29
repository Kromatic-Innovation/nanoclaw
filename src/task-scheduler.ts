import { ChildProcess, execFile } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

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
  getPipelinePromptTemplate,
} from './pipeline-runner.js';
import {
  runPreflight,
  formatPreflightSlackMessage,
  type PreflightResult,
} from './preflight.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import type { ClassifiedItem } from 'tickle-stick';

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

const BOX_CLAUDE_CONCURRENCY = 3;
const BOX_CLAUDE_MAX_RETRIES = 2;

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
        timeout: 60 * 60 * 1000, // 60 minutes per repo
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

/**
 * Run box-claude for a single repo with retry on partial completion.
 * Returns the combined report text for this repo.
 */
async function runBoxClaudeForRepo(
  repoSlug: string,
  repoItems: ClassifiedItem[],
  promptTemplate: string,
): Promise<string> {
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
        return completion.summary || stdout.slice(-2000);
      }

      if (completion?.status === 'failed') {
        logger.warn({ repo: repoSlug, taskId }, 'Box-claude reported failure');
        return `[FAILED] ${repoSlug}: ${completion.summary}`;
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

      // No completion.json — likely context exhaustion or crash
      if (exitCode === 0) {
        logger.warn(
          { repo: repoSlug, retryCount, taskId },
          'Box-claude exited 0 but no completion.json — likely context exhaustion',
        );
        priorContext = {
          sessionSummary:
            'Previous session ended without writing completion status',
          completedSteps: [],
          remainingSteps: ['Check current state and continue'],
          lastCheckpoint: 'Unknown — check GitHub for current state',
        };
        retryCount++;
        continue;
      }

      // Non-zero exit — crash
      logger.error({ repo: repoSlug, exitCode, taskId }, 'Box-claude crashed');
      return `[CRASHED] ${repoSlug}: exit code ${exitCode}`;
    } catch (err) {
      logger.error(
        { repo: repoSlug, err, taskId },
        'Failed to spawn box-claude',
      );
      return `[ERROR] ${repoSlug}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return `[EXHAUSTED] ${repoSlug}: gave up after ${BOX_CLAUDE_MAX_RETRIES + 1} attempts`;
}

/**
 * Process Tier 2 items by spawning per-repo box-claude instances.
 * Replaces the old single-container onTier2 callback.
 */
async function processTier2ViaBoxClaude(
  items: ClassifiedItem[],
  pipelineName: string,
): Promise<string> {
  const repoGroups = groupItemsByRepo(items);

  // Load prompt template: prefer file-based prompt for plan pipeline,
  // fall back to YAML tier2.prompt, then a default.
  let promptTemplate: string;
  if (pipelineName === 'repo-maintenance-plan') {
    const promptFile = path.join(process.cwd(), 'prompts', 'plan-writing.md');
    promptTemplate = fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, 'utf-8')
      : getPipelinePromptTemplate(pipelineName) ||
        'Process these items:\n{{items}}';
  } else {
    promptTemplate =
      getPipelinePromptTemplate(pipelineName) ||
      'Process these items:\n{{items}}';
  }

  logger.info(
    { repoCount: repoGroups.size, itemCount: items.length },
    'Processing Tier 2 via box-claude',
  );

  // Process repos with concurrency limit
  const repos = Array.from(repoGroups.entries());
  const results: string[] = [];
  const running: Promise<void>[] = [];

  for (const [repoSlug, repoItems] of repos) {
    const task = (async () => {
      const report = await runBoxClaudeForRepo(
        repoSlug,
        repoItems,
        promptTemplate,
      );
      results.push(`## ${repoSlug}\n${report}`);
    })();

    running.push(task);

    // Enforce concurrency limit
    if (running.length >= BOX_CLAUDE_CONCURRENCY) {
      await Promise.race(running);
      // Remove settled promises
      for (let i = running.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          running[i].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) running.splice(i, 1);
      }
    }
  }

  // Wait for remaining
  await Promise.allSettled(running);

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
      // Look for references like "other-repo#123" or "owner/other-repo#123"
      for (const otherRepo of allRepos) {
        if (otherRepo === repo) continue;
        const [, repoName] = otherRepo.split('/');
        if (body.includes(repoName) || body.includes(otherRepo)) {
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

  return lanes;
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
      const triageResult = await runPipeline(
        'repo-maintenance-triage',
        // onTier2: capture classified items for later phases (no execution)
        async (items) => {
          // Filter to requested repos if --repos was specified
          if (config.repos && config.repos.length > 0) {
            items = items.filter((item) => {
              const slug = extractRepoSlug(item);
              return config.repos!.some((r) => slug.includes(r));
            });
          }
          classifiedItems = items;
          const repoGroups = groupItemsByRepo(items);
          const summary = Array.from(repoGroups.entries())
            .map(([repo, repoItems]) => `${repo}: ${repoItems.length} items`)
            .join(', ');
          return `Classified ${items.length} items across ${repoGroups.size} repos: ${summary}`;
        },
        // onTier3: capture human items
        async (items) => {
          humanItems = items;
          const msg = items.map((i) => `[${i.source}] ${i.summary}`).join('\n');
          await deps.sendMessage(
            chatJid,
            `Items needing human attention:\n${msg}`,
          );
        },
      );

      const triageSummary = `Triage complete. ${triageResult.tier0Items} items found: T1=${triageResult.tier1Classified} classified, T2=${triageResult.tier2Escalated} for processing, T3=${triageResult.tier3Human} for human review`;
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
      const laneResults: string[] = [];
      const running: Promise<void>[] = [];

      for (const lane of lanes) {
        const laneTask = (async () => {
          const promptTemplate =
            getPipelinePromptTemplate('repo-maintenance-execute') ||
            'Process these items:\n{{items}}';

          // For multi-repo lanes, combine all items into one prompt
          const report =
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

          laneResults.push(`## ${lane.repos.join(' + ')}\n${report}`);

          // Post-lane cleanup
          await runPostLaneCleanup(lane);

          // Per-lane Slack update
          await deps.sendMessage(
            chatJid,
            `Lane complete: ${lane.repos.join(' + ')}`,
          );
        })();

        running.push(laneTask);

        // Enforce concurrency limit
        if (running.length >= config.concurrency) {
          await Promise.race(running);
          for (let i = running.length - 1; i >= 0; i--) {
            const settled = await Promise.race([
              running[i].then(() => true),
              Promise.resolve(false),
            ]);
            if (settled) running.splice(i, 1);
          }
        }
      }

      await Promise.allSettled(running);

      const execSummary = `Execution complete. ${lanes.length} lanes processed.`;
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
        const pipelineResult = await runPipeline(
          pipelinePrompt,
          // onTier2: spawn per-repo box-claude instances
          async (items, _prompt) => {
            return processTier2ViaBoxClaude(items, pipelinePrompt);
          },
          // onTier3: send human items to channel
          async (items) => {
            const msg = items
              .map((i) => `[${i.source}] ${i.summary}`)
              .join('\n');
            await deps.sendMessage(
              task.chat_jid,
              `Items needing human attention:\n${msg}`,
            );
          },
        );

        result = formatPipelineReport(pipelineResult);
        if (result) {
          await deps.sendMessage(task.chat_jid, result);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logger.error(
          { taskId: task.id, pipelineName: pipelinePrompt, error },
          'Pipeline failed',
        );
      }
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

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
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
