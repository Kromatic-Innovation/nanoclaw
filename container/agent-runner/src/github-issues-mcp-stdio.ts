/**
 * GitHub Issues MCP Server (container-side proxy)
 *
 * Runs inside the container. Exposes GitHub Issues tools to the agent.
 * Communicates with the host via IPC files:
 *   - Writes request to /workspace/ipc/github-issues/requests/{id}.json
 *   - Polls for response at /workspace/ipc/github-issues/responses/{id}.json
 *
 * The host-side IPC watcher executes the actual `gh` CLI commands
 * (which require authenticated credentials) and writes the response back.
 *
 * Configuration:
 *   - Repo map at /workspace/global/repos.json maps project paths to owner/repo.
 *   - Env fallbacks: GITHUB_OWNER, GITHUB_REPO (from host launchd plist).
 *   - Each tool also accepts optional owner/repo params to override defaults.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'github-issues', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'github-issues', 'responses');

const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 30_000;

const DEFAULT_OWNER = process.env.GITHUB_OWNER || '';
const DEFAULT_REPO = process.env.GITHUB_REPO || '';

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Send a request to the host via IPC and wait for a response.
 */
async function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = generateRequestId();
  const requestFile = path.join(REQUESTS_DIR, `${requestId}.json`);
  const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);

  fs.mkdirSync(REQUESTS_DIR, { recursive: true });

  // Inject defaults for owner/repo if not provided
  const enrichedArgs = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    ...args,
  };

  // Atomic write
  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(
    tempFile,
    JSON.stringify({ id: requestId, tool, args: enrichedArgs }),
  );
  fs.renameSync(tempFile, requestFile);

  // Poll for response
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const raw = fs.readFileSync(responseFile, 'utf-8');
      fs.unlinkSync(responseFile);
      const response = JSON.parse(raw);
      if (response.error) {
        throw new Error(response.error);
      }
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `GitHub Issues IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// --- Shared schema fragments ---

const ownerParam = z
  .string()
  .optional()
  .describe('GitHub owner (org or user). Defaults to GITHUB_OWNER env var.');
const repoParam = z
  .string()
  .optional()
  .describe('GitHub repo name. Defaults to GITHUB_REPO env var.');

// --- MCP Server ---

const server = new McpServer({
  name: 'github-issues',
  version: '1.0.0',
});

// READ tools

server.tool(
  'list_issues',
  'List issues in a GitHub repo (filter by state, labels, assignee, milestone)',
  {
    owner: ownerParam,
    repo: repoParam,
    state: z
      .enum(['open', 'closed', 'all'])
      .default('open')
      .describe('Filter by issue state'),
    labels: z
      .string()
      .optional()
      .describe('Comma-separated label names to filter by'),
    assignee: z.string().optional().describe('Filter by assignee username'),
    milestone: z
      .string()
      .optional()
      .describe('Filter by milestone title or number'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(30)
      .describe('Max issues to return (default 30, max 100)'),
  },
  async (args) => textResult(await ipcRequest('list_issues', args)),
);

server.tool(
  'get_issue',
  'Get full details of a GitHub issue including comments',
  {
    owner: ownerParam,
    repo: repoParam,
    issue_number: z.number().describe('Issue number'),
  },
  async (args) => textResult(await ipcRequest('get_issue', args)),
);

server.tool(
  'search_issues',
  'Search issues across repos using GitHub search syntax',
  {
    owner: ownerParam,
    repo: repoParam,
    query: z
      .string()
      .describe(
        'Search query (GitHub search syntax, e.g. "bug label:critical")',
      ),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(30)
      .describe('Max results to return'),
  },
  async (args) => textResult(await ipcRequest('search_issues', args)),
);

server.tool(
  'list_labels',
  'List available labels in a GitHub repo',
  {
    owner: ownerParam,
    repo: repoParam,
  },
  async (args) => textResult(await ipcRequest('list_labels', args)),
);

server.tool(
  'list_milestones',
  'List milestones in a GitHub repo',
  {
    owner: ownerParam,
    repo: repoParam,
    state: z
      .enum(['open', 'closed', 'all'])
      .default('open')
      .describe('Filter by milestone state'),
  },
  async (args) => textResult(await ipcRequest('list_milestones', args)),
);

// WRITE tools

server.tool(
  'create_issue',
  'Create a new GitHub issue',
  {
    owner: ownerParam,
    repo: repoParam,
    title: z.string().describe('Issue title'),
    body: z.string().optional().describe('Issue body (Markdown)'),
    labels: z.array(z.string()).optional().describe('Labels to apply'),
    assignees: z.array(z.string()).optional().describe('Usernames to assign'),
    milestone: z.number().optional().describe('Milestone number to associate'),
  },
  async (args) => textResult(await ipcRequest('create_issue', args)),
);

server.tool(
  'update_issue',
  'Update an existing GitHub issue (title, body, state, labels, assignee, milestone)',
  {
    owner: ownerParam,
    repo: repoParam,
    issue_number: z.number().describe('Issue number to update'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body (Markdown)'),
    state: z.enum(['open', 'closed']).optional().describe('Set issue state'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Replace all labels with these'),
    assignees: z
      .array(z.string())
      .optional()
      .describe('Replace all assignees with these'),
    milestone: z
      .number()
      .nullable()
      .optional()
      .describe('Milestone number (null to remove)'),
  },
  async (args) => textResult(await ipcRequest('update_issue', args)),
);

server.tool(
  'add_comment',
  'Add a comment to a GitHub issue',
  {
    owner: ownerParam,
    repo: repoParam,
    issue_number: z.number().describe('Issue number'),
    body: z.string().describe('Comment body (Markdown)'),
  },
  async (args) => textResult(await ipcRequest('add_comment', args)),
);

server.tool(
  'create_label',
  'Create a new label in a GitHub repo',
  {
    owner: ownerParam,
    repo: repoParam,
    name: z.string().describe('Label name'),
    description: z.string().optional().describe('Label description'),
    color: z
      .string()
      .optional()
      .describe('Label color as hex without # (e.g. "ff0000")'),
  },
  async (args) => textResult(await ipcRequest('create_label', args)),
);

server.tool(
  'create_milestone',
  'Create a new milestone in a GitHub repo',
  {
    owner: ownerParam,
    repo: repoParam,
    title: z.string().describe('Milestone title'),
    description: z.string().optional().describe('Milestone description'),
    due_on: z
      .string()
      .optional()
      .describe('Due date in ISO 8601 format (e.g. "2026-04-01T00:00:00Z")'),
  },
  async (args) => textResult(await ipcRequest('create_milestone', args)),
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
