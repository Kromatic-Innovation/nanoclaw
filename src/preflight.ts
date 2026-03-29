import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreflightResult {
  repos: RepoPreflightReport[];
  humanAttentionItems: { repo: string; description: string }[];
  duration_ms: number;
}

export interface RepoPreflightReport {
  repo: string;
  repoPath: string;
  hygieneStatus: 'clean' | 'dirty' | 'error';
  currentBranch: string;
  syncStatus: string;
  localStagingDeleted: boolean;
  localMainDeleted: boolean;
  branchesPruned: number;
  pendingPlans: string[];
  dirtyFiles: DirtyFileResult | null;
}

export interface DirtyFileResult {
  knownIgnorable: string[];
  unknownFiles: string[];
  llmDecisions: {
    file: string;
    category: 'ignorable' | 'partial-work' | 'escalate';
    reason: string;
  }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE = path.resolve(process.cwd(), '..');
const HYGIENE_SCRIPT = path.join(WORKSPACE, 'scripts', 'repo_hygiene.py');
// repo_cleanup_triage.sh is called via repo_hygiene.py --apply-cleanup,
// not directly from this module.

/** File patterns that are always safe to ignore in dirty worktree checks. */
const IGNORABLE_PATTERNS = [
  /^\.claude\//,
  /^\.codex\//,
  /^\.venv\//,
  /^\.tmp\//,
  /^node_modules\//,
  /^__pycache__\//,
  /^\.env$/,
  /^\.env\.local$/,
  /\.pyc$/,
  /^\.DS_Store$/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execScript(
  command: string,
  args: string[],
  timeout = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr)
          logger.debug(
            { stderr: stderr.slice(-500) },
            'preflight script stderr',
          );
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/** Delete a local branch if it exists. Returns true if deleted. */
function deleteLocalBranch(repoPath: string, branch: string): boolean {
  try {
    const result = require('child_process').execFileSync(
      'git',
      ['-C', repoPath, 'branch', '-D', branch],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    logger.info(
      { repoPath, branch, result: result.trim() },
      'Deleted local branch',
    );
    return true;
  } catch {
    return false;
  }
}

/** Get list of dirty files from git status --porcelain. */
function getDirtyFiles(repoPath: string): string[] {
  try {
    const output = require('child_process').execFileSync(
      'git',
      ['-C', repoPath, 'status', '--porcelain'],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    return output
      .split('\n')
      .filter((line: string) => line.trim())
      .map((line: string) => line.slice(3).trim());
  } catch {
    return [];
  }
}

/** Check if a file matches known ignorable patterns. */
function isIgnorable(filePath: string): boolean {
  return IGNORABLE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** Find .codex/plans/*.md files in a repo. */
function findPendingPlans(repoPath: string): string[] {
  const plansDir = path.join(repoPath, '.codex', 'plans');
  if (!fs.existsSync(plansDir)) return [];
  try {
    return fs
      .readdirSync(plansDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join('.codex', 'plans', f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM categorization for unknown dirty files
// ---------------------------------------------------------------------------

/**
 * Categorize unknown dirty files using a light LLM call.
 * Uses the HttpTriageProvider if available, otherwise returns
 * all files as 'escalate'.
 */
async function categorizeDirtyFiles(
  files: string[],
  repoSlug: string,
  triageProvider?: {
    classify: (systemPrompt: string, content: string) => Promise<string>;
  },
): Promise<DirtyFileResult['llmDecisions']> {
  if (!triageProvider || files.length === 0) {
    return files.map((f) => ({
      file: f,
      category: 'escalate' as const,
      reason: 'No triage provider available',
    }));
  }

  const systemPrompt = `You are categorizing uncommitted files in a git repository.
For each file path, classify it as one of:
- "ignorable": config files, caches, virtual environments, IDE settings, build artifacts
- "partial-work": source code, test files, or documentation that appears to be in-progress work
- "escalate": cannot determine, needs human review

Respond with a JSON array:
[{"file": "path", "category": "ignorable|partial-work|escalate", "reason": "brief reason"}]`;

  const content = `Repository: ${repoSlug}\nFiles:\n${files.map((f) => `- ${f}`).join('\n')}`;

  try {
    const response = await triageProvider.classify(systemPrompt, content);
    const parsed = JSON.parse(response);
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    logger.warn({ err, repoSlug }, 'LLM categorization failed');
  }

  return files.map((f) => ({
    file: f,
    category: 'escalate' as const,
    reason: 'LLM categorization failed',
  }));
}

// ---------------------------------------------------------------------------
// Main preflight function
// ---------------------------------------------------------------------------

interface PreflightOptions {
  repos?: string[];
  applyCleanup?: boolean;
  triageProvider?: {
    classify: (systemPrompt: string, content: string) => Promise<string>;
  };
}

/**
 * Run preflight cleanup and hygiene checks across repos.
 *
 * 1. Run repo_hygiene.py for sync/cleanup
 * 2. Delete local staging/main branches
 * 3. Detect pending plans (.codex/plans/)
 * 4. Categorize dirty files (known patterns + LLM for unknowns)
 */
export async function runPreflight(
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const startTime = Date.now();
  const results: RepoPreflightReport[] = [];
  const humanAttentionItems: PreflightResult['humanAttentionItems'] = [];

  // Step 1: Run repo_hygiene.py to get structured hygiene data
  const hygieneArgs = ['--json', '--apply-cleanup', '--apply-checkout'];
  if (options.repos && options.repos.length > 0) {
    // Run per-repo
    for (const repoSlug of options.repos) {
      // Find repo path from repos.json
      const repoPath = resolveRepoPath(repoSlug);
      if (repoPath) {
        hygieneArgs.push('--repo-path', repoPath);
      }
    }
  } else {
    hygieneArgs.push('--all-workspace');
  }

  let hygieneData: { repos: HygieneRepoResult[] } = { repos: [] };
  try {
    const output = await execScript(
      'python3',
      [HYGIENE_SCRIPT, ...hygieneArgs],
      300_000,
    );
    hygieneData = JSON.parse(output);
  } catch (err) {
    logger.error({ err }, 'Failed to run repo_hygiene.py');
    return {
      repos: [],
      humanAttentionItems: [
        { repo: '*', description: 'repo_hygiene.py failed to run' },
      ],
      duration_ms: Date.now() - startTime,
    };
  }

  // Step 2-4: Process each repo
  for (const repo of hygieneData.repos) {
    const repoPath = repo.repo_root;
    const repoSlug = repo.github_repo || repo.repo_name;

    // Delete local staging/main branches
    const stagingDeleted = deleteLocalBranch(repoPath, 'staging');
    const mainDeleted = deleteLocalBranch(repoPath, 'main');

    // Find pending plans
    const pendingPlans = findPendingPlans(repoPath);

    // Check dirty files
    const dirtyFilesList = getDirtyFiles(repoPath);
    let dirtyFiles: DirtyFileResult | null = null;

    if (dirtyFilesList.length > 0) {
      const knownIgnorable = dirtyFilesList.filter(isIgnorable);
      const unknownFiles = dirtyFilesList.filter((f) => !isIgnorable(f));

      let llmDecisions: DirtyFileResult['llmDecisions'] = [];
      if (unknownFiles.length > 0) {
        llmDecisions = await categorizeDirtyFiles(
          unknownFiles,
          repoSlug,
          options.triageProvider,
        );

        // Escalate items that need human attention
        for (const decision of llmDecisions) {
          if (decision.category === 'escalate') {
            humanAttentionItems.push({
              repo: repoSlug,
              description: `Uncommitted file needs review: ${decision.file} (${decision.reason})`,
            });
          } else if (decision.category === 'partial-work') {
            humanAttentionItems.push({
              repo: repoSlug,
              description: `Partial work detected: ${decision.file} — may need branch commit`,
            });
          }
        }
      }

      dirtyFiles = { knownIgnorable, unknownFiles, llmDecisions };
    }

    // Determine overall hygiene status
    const triage = repo.local_triage;
    const cleanupCount =
      (triage?.local_deleted || 0) +
      (triage?.remote_deleted || 0) +
      (triage?.worktrees_deleted || 0);

    const hygieneStatus: RepoPreflightReport['hygieneStatus'] =
      dirtyFilesList.filter((f) => !isIgnorable(f)).length > 0
        ? 'dirty'
        : triage?.ok === false
          ? 'error'
          : 'clean';

    results.push({
      repo: repoSlug,
      repoPath,
      hygieneStatus,
      currentBranch: triage?.current_branch || 'unknown',
      syncStatus: repo.local_sync?.status || 'unknown',
      localStagingDeleted: stagingDeleted,
      localMainDeleted: mainDeleted,
      branchesPruned: cleanupCount,
      pendingPlans,
      dirtyFiles,
    });
  }

  return {
    repos: results,
    humanAttentionItems,
    duration_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format preflight results for Slack reporting. */
export function formatPreflightSlackMessage(result: PreflightResult): string {
  const clean = result.repos.filter((r) => r.hygieneStatus === 'clean').length;
  const dirty = result.repos.filter((r) => r.hygieneStatus === 'dirty').length;
  const errors = result.repos.filter((r) => r.hygieneStatus === 'error').length;

  const lines: string[] = [
    `Cleanup complete (${(result.duration_ms / 1000).toFixed(1)}s). ${result.repos.length} repos checked: ${clean} clean, ${dirty} dirty, ${errors} errors.`,
  ];

  // Report staging/main deletions
  const stagingDeleted = result.repos.filter((r) => r.localStagingDeleted);
  const mainDeleted = result.repos.filter((r) => r.localMainDeleted);
  if (stagingDeleted.length > 0) {
    lines.push(
      `Deleted local staging branches: ${stagingDeleted.map((r) => r.repo).join(', ')}`,
    );
  }
  if (mainDeleted.length > 0) {
    lines.push(
      `Deleted local main branches: ${mainDeleted.map((r) => r.repo).join(', ')}`,
    );
  }

  // Report pending plans
  const withPlans = result.repos.filter((r) => r.pendingPlans.length > 0);
  if (withPlans.length > 0) {
    lines.push(
      `Pending plans found: ${withPlans.map((r) => `${r.repo} (${r.pendingPlans.length})`).join(', ')}`,
    );
  }

  // Report human attention items
  if (result.humanAttentionItems.length > 0) {
    lines.push('');
    lines.push('Items needing human attention:');
    for (const item of result.humanAttentionItems) {
      lines.push(`- [${item.repo}] ${item.description}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface HygieneRepoResult {
  repo_name: string;
  repo_root: string;
  github_repo: string;
  local_triage: {
    current_branch: string;
    ok: boolean;
    local_deleted?: number;
    remote_deleted?: number;
    worktrees_deleted?: number;
    [key: string]: unknown;
  };
  local_sync: {
    status: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Resolve a repo slug (e.g. "owner/repo-name") to its local path. */
function resolveRepoPath(repoSlug: string): string | null {
  const reposJsonPath = path.join(
    process.cwd(),
    'groups',
    'global',
    'repos.json',
  );
  try {
    const repos = JSON.parse(fs.readFileSync(reposJsonPath, 'utf-8')) as {
      path: string;
      owner: string;
      repo: string;
    }[];
    const [owner, name] = repoSlug.split('/');
    const match = repos.find((r) => r.owner === owner && r.repo === name);
    if (match) {
      return path.join(WORKSPACE, match.path);
    }
  } catch {
    logger.warn({ repoSlug }, 'Could not resolve repo path from repos.json');
  }
  return null;
}
