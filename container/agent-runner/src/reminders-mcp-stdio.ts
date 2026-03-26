/**
 * Apple Reminders MCP Server (container-side proxy)
 *
 * Runs inside the container. Exposes Reminders tools to the agent.
 * Communicates with the host via IPC files:
 *   - Writes request to /workspace/ipc/reminders/requests/{id}.json
 *   - Polls for response at /workspace/ipc/reminders/responses/{id}.json
 *
 * The host-side IPC watcher executes the actual JXA/osascript commands
 * (which require macOS) and writes the response back.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'reminders', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'reminders', 'responses');

const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 30_000;

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

  // Atomic write
  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify({ id: requestId, tool, args }));
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
    `Reminders IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({
  name: 'apple-reminders',
  version: '1.0.0',
});

server.tool(
  'list_reminder_lists',
  'List all reminder lists in Apple Reminders',
  {},
  async () => textResult(await ipcRequest('list_reminder_lists', {})),
);

server.tool(
  'get_reminders',
  'Get reminders from a specific list',
  {
    list: z.string().describe('Name of the reminder list'),
    include_completed: z
      .boolean()
      .default(false)
      .describe('Include completed reminders (default: false)'),
  },
  async (args) => textResult(await ipcRequest('get_reminders', args)),
);

server.tool(
  'create_reminder',
  'Create a new reminder in a specific list',
  {
    list: z.string().describe('Name of the reminder list'),
    name: z.string().describe('Title of the reminder'),
    body: z.string().optional().describe('Notes/body text for the reminder'),
    due_date: z
      .string()
      .optional()
      .describe('Due date in ISO 8601 format (e.g. 2026-03-25T10:00:00)'),
    priority: z
      .number()
      .min(0)
      .max(9)
      .optional()
      .describe('Priority: 0 = none, 1-4 = high, 5 = medium, 6-9 = low'),
    flagged: z.boolean().optional().describe('Flag the reminder'),
  },
  async (args) => textResult(await ipcRequest('create_reminder', args)),
);

server.tool(
  'complete_reminder',
  'Mark a reminder as complete or incomplete',
  {
    list: z.string().describe('Name of the reminder list'),
    reminder_id: z.string().describe('ID of the reminder'),
    completed: z
      .boolean()
      .default(true)
      .describe('Set to true to complete, false to uncomplete'),
  },
  async (args) => textResult(await ipcRequest('complete_reminder', args)),
);

server.tool(
  'create_list',
  'Create a new reminder list',
  {
    name: z.string().describe('Name for the new list'),
  },
  async (args) => textResult(await ipcRequest('create_list', args)),
);

server.tool(
  'search_reminders',
  'Search reminders across all lists by text in name or notes',
  {
    query: z.string().describe('Search text (case-insensitive)'),
    include_completed: z
      .boolean()
      .default(false)
      .describe('Include completed reminders in search'),
  },
  async (args) => textResult(await ipcRequest('search_reminders', args)),
);

server.tool(
  'get_reminder_detail',
  'Get full details of a specific reminder including dates and metadata',
  {
    list: z.string().describe('Name of the reminder list'),
    reminder_id: z.string().describe('ID of the reminder'),
  },
  async (args) => textResult(await ipcRequest('get_reminder_detail', args)),
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
