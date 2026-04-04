/**
 * Host-side GitHub Issues IPC handler.
 *
 * Watches for request files from containers in {group}/github-issues/requests/,
 * executes `gh` CLI commands, and writes responses to
 * {group}/github-issues/responses/.
 *
 * Requires `gh` CLI authenticated on the host.
 */

import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface GitHubIssuesRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run a `gh` CLI command and return the parsed JSON result.
 */
function runGh(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh error: ${stderr || error.message}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          // Some gh commands return plain text
          resolve(trimmed);
        }
      },
    );
  });
}

/**
 * Build the repo flag for gh commands: "owner/repo"
 */
function repoSlug(args: Record<string, unknown>): string {
  const owner = args.owner as string;
  const repo = args.repo as string;
  if (!owner || !repo) {
    throw new Error(
      'Missing owner or repo. Set GITHUB_OWNER/GITHUB_REPO env vars or pass per-call.',
    );
  }
  return `${owner}/${repo}`;
}

// --- Tool handlers ---

async function listIssues(args: Record<string, unknown>): Promise<unknown> {
  const ghArgs = [
    'issue',
    'list',
    '-R',
    repoSlug(args),
    '--json',
    'number,title,state,labels,assignees,milestone,createdAt,updatedAt,url',
    '--state',
    (args.state as string) || 'open',
    '--limit',
    String(args.limit || 30),
  ];
  if (args.labels) {
    ghArgs.push('--label', args.labels as string);
  }
  if (args.assignee) {
    ghArgs.push('--assignee', args.assignee as string);
  }
  if (args.milestone) {
    ghArgs.push('--milestone', args.milestone as string);
  }
  return runGh(ghArgs);
}

async function getIssue(args: Record<string, unknown>): Promise<unknown> {
  const issueNumber = args.issue_number as number;
  const ghArgs = [
    'issue',
    'view',
    String(issueNumber),
    '-R',
    repoSlug(args),
    '--json',
    'number,title,body,state,labels,assignees,milestone,comments,createdAt,updatedAt,url,author',
  ];
  return runGh(ghArgs);
}

async function searchIssues(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string;
  const slug = repoSlug(args);
  const limit = args.limit || 30;
  const ghArgs = [
    'search',
    'issues',
    '--repo',
    slug,
    '--json',
    'number,title,state,labels,assignees,url,createdAt,updatedAt',
    '--limit',
    String(limit),
    query,
  ];
  return runGh(ghArgs);
}

async function listLabels(args: Record<string, unknown>): Promise<unknown> {
  const ghArgs = [
    'label',
    'list',
    '-R',
    repoSlug(args),
    '--json',
    'name,description,color',
  ];
  return runGh(ghArgs);
}

async function listMilestones(args: Record<string, unknown>): Promise<unknown> {
  const state = (args.state as string) || 'open';
  const ghArgs = [
    'api',
    `repos/${repoSlug(args)}/milestones?state=${state}`,
    '--jq',
    '.',
  ];
  return runGh(ghArgs);
}

async function createIssue(args: Record<string, unknown>): Promise<unknown> {
  const ghArgs = [
    'issue',
    'create',
    '-R',
    repoSlug(args),
    '--title',
    args.title as string,
  ];
  if (args.body) {
    ghArgs.push('--body', args.body as string);
  }
  if (args.labels && Array.isArray(args.labels)) {
    for (const label of args.labels as string[]) {
      ghArgs.push('--label', label);
    }
  }
  if (args.assignees && Array.isArray(args.assignees)) {
    for (const assignee of args.assignees as string[]) {
      ghArgs.push('--assignee', assignee);
    }
  }
  if (args.milestone != null) {
    ghArgs.push('--milestone', String(args.milestone));
  }
  // gh issue create doesn't support --json; it prints the issue URL on success.
  // Create the issue, then fetch it as JSON via gh issue view.
  const result = await runGh(ghArgs);
  const url = typeof result === 'string' ? result.trim() : '';
  const match = url.match(/\/issues\/(\d+)$/);
  if (match) {
    return runGh([
      'issue',
      'view',
      match[1],
      '-R',
      repoSlug(args),
      '--json',
      'number,title,state,url,labels,assignees,milestone',
    ]);
  }
  // Fallback: return the URL string if we can't parse an issue number
  return { url, title: args.title };
}

async function updateIssue(args: Record<string, unknown>): Promise<unknown> {
  const issueNumber = args.issue_number as number;
  const slug = repoSlug(args);

  // gh issue edit doesn't return JSON, so we edit then fetch
  const editArgs = ['issue', 'edit', String(issueNumber), '-R', slug];

  if (args.title) {
    editArgs.push('--title', args.title as string);
  }
  if (args.body) {
    editArgs.push('--body', args.body as string);
  }
  if (args.milestone !== undefined) {
    if (args.milestone === null) {
      editArgs.push('--milestone', '');
    } else {
      editArgs.push('--milestone', String(args.milestone));
    }
  }
  if (args.labels && Array.isArray(args.labels)) {
    // --add-label replaces when combined with remove, but simplest to use API
    // For full replacement, we clear then add
    editArgs.push('--remove-label', '');
    for (const label of args.labels as string[]) {
      editArgs.push('--add-label', label);
    }
  }
  if (args.assignees && Array.isArray(args.assignees)) {
    // Clear existing assignees by removing all, then add new ones
    editArgs.push('--remove-assignee', '');
    for (const assignee of args.assignees as string[]) {
      editArgs.push('--add-assignee', assignee);
    }
  }

  await runGh(editArgs);

  // Handle state change separately (gh issue close / gh issue reopen)
  if (args.state === 'closed') {
    await runGh(['issue', 'close', String(issueNumber), '-R', slug]);
  } else if (args.state === 'open') {
    await runGh(['issue', 'reopen', String(issueNumber), '-R', slug]);
  }

  // Fetch and return updated issue
  return runGh([
    'issue',
    'view',
    String(issueNumber),
    '-R',
    slug,
    '--json',
    'number,title,body,state,labels,assignees,milestone,url',
  ]);
}

async function addComment(args: Record<string, unknown>): Promise<unknown> {
  const issueNumber = args.issue_number as number;
  const ghArgs = [
    'issue',
    'comment',
    String(issueNumber),
    '-R',
    repoSlug(args),
    '--body',
    args.body as string,
  ];
  await runGh(ghArgs);
  return { success: true, issue_number: issueNumber };
}

async function createLabel(args: Record<string, unknown>): Promise<unknown> {
  const ghArgs = ['label', 'create', args.name as string, '-R', repoSlug(args)];
  if (args.description) {
    ghArgs.push('--description', args.description as string);
  }
  if (args.color) {
    ghArgs.push('--color', args.color as string);
  }
  ghArgs.push('--force'); // Don't error if label already exists
  await runGh(ghArgs);
  return { success: true, name: args.name };
}

async function createMilestone(
  args: Record<string, unknown>,
): Promise<unknown> {
  // gh doesn't have a native milestone create command, use the API
  const slug = repoSlug(args);
  const body: Record<string, unknown> = {
    title: args.title as string,
  };
  if (args.description) {
    body.description = args.description as string;
  }
  if (args.due_on) {
    body.due_on = args.due_on as string;
  }
  const ghArgs = [
    'api',
    `repos/${slug}/milestones`,
    '--method',
    'POST',
    '--input',
    '-',
  ];
  // Pass body via stdin
  return new Promise((resolve, reject) => {
    const proc = spawn('gh', ghArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`gh error: ${stderr || `exit code ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(stdout.trim());
      }
    });
    proc.stdin.write(JSON.stringify(body));
    proc.stdin.end();
  });
}

// --- Tool dispatcher ---

async function handleRequest(req: GitHubIssuesRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'list_issues':
      return listIssues(args);
    case 'get_issue':
      return getIssue(args);
    case 'search_issues':
      return searchIssues(args);
    case 'list_labels':
      return listLabels(args);
    case 'list_milestones':
      return listMilestones(args);
    case 'create_issue':
      return createIssue(args);
    case 'update_issue':
      return updateIssue(args);
    case 'add_comment':
      return addComment(args);
    case 'create_label':
      return createLabel(args);
    case 'create_milestone':
      return createMilestone(args);
    default:
      throw new Error(`Unknown github-issues tool: ${tool}`);
  }
}

/**
 * Process all pending GitHub Issues IPC requests in a given group's IPC directory.
 */
export function processGithubIssuesIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'github-issues', 'requests');
  const responsesDir = path.join(groupIpcDir, 'github-issues', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: GitHubIssuesRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse github-issues IPC request');
      fs.unlinkSync(requestPath);
      continue;
    }

    // Delete the request file immediately to avoid reprocessing
    fs.unlinkSync(requestPath);

    // Process async — write response when done
    handleRequest(req)
      .then((result) => {
        writeResponse(responsesDir, req.id, { result });
      })
      .catch((err) => {
        logger.error(
          { requestId: req.id, tool: req.tool, err },
          'GitHub Issues IPC error',
        );
        writeResponse(responsesDir, req.id, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

function writeResponse(
  responsesDir: string,
  requestId: string,
  data: { result?: unknown; error?: string },
): void {
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, responsePath);
}
