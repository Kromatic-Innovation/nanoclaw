/**
 * Gmail MCP Server (container-side proxy)
 *
 * Exposes Gmail tools to the agent via IPC bridge.
 * Mutating operations are permission-gated by email-action-guard on the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'gmail', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'gmail', 'responses');
const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 30_000;

function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = generateRequestId();
  const requestFile = path.join(REQUESTS_DIR, `${requestId}.json`);
  const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify({ id: requestId, tool, args }));
  fs.renameSync(tempFile, requestFile);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const raw = fs.readFileSync(responseFile, 'utf-8');
      fs.unlinkSync(responseFile);
      const response = JSON.parse(raw);
      if (response.error) throw new Error(response.error);
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Gmail IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`);
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const accountParam = z
  .enum(['1', '2'])
  .optional()
  .default('1')
  .describe('Google account to use: "1" (default/primary) or "2" (secondary)');

const server = new McpServer({ name: 'gmail', version: '1.0.0' });

// --- Read-only ---

server.tool(
  'list_messages',
  'List Gmail messages matching a query',
  {
    query: z
      .string()
      .optional()
      .describe('Gmail search query (e.g. "in:inbox newer_than:7d")'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of messages to return'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('list_messages', args)),
);

server.tool(
  'get_message',
  'Get a single Gmail message by ID',
  {
    message_id: z.string().describe('Gmail message ID'),
    format: z
      .enum(['full', 'metadata', 'minimal', 'raw'])
      .optional()
      .describe('Response format'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_message', args)),
);

server.tool(
  'get_thread',
  'Get all messages in a Gmail thread',
  {
    message_id: z
      .string()
      .describe('Message ID (thread is resolved from this)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_thread', args)),
);

server.tool(
  'list_labels',
  'List all Gmail labels',
  { account: accountParam },
  async (args) => textResult(await ipcRequest('list_labels', args)),
);

server.tool(
  'create_label',
  'Create a new Gmail label',
  {
    name: z.string().describe('Label name'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('create_label', args)),
);

// --- Mutating (permission-gated by host) ---

server.tool(
  'send_new',
  'Send a new email. Permission-gated by contact database.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body text'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('send_new', args)),
);

server.tool(
  'send_reply_all',
  'Reply-all to an existing email thread. Permission-gated.',
  {
    message_id: z.string().describe('Message ID to reply to'),
    body: z.string().describe('Reply body text'),
    cc: z
      .string()
      .optional()
      .describe('Comma-separated CC recipients (email addresses)'),
    allow_self: z.boolean().optional().describe('Allow replying to self'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('send_reply_all', args)),
);

server.tool(
  'draft_new',
  'Create a new email draft. Permission-gated by contact database.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body text'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('draft_new', args)),
);

server.tool(
  'draft_reply',
  'Create a reply draft to a message. Permission-gated.',
  {
    message_id: z.string().describe('Message ID to reply to'),
    body: z.string().describe('Reply body text'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('draft_reply', args)),
);

server.tool(
  'draft_reply_all',
  'Create a reply-all draft. Permission-gated.',
  {
    message_id: z.string().describe('Message ID to reply to'),
    body: z.string().describe('Reply body text'),
    cc: z
      .string()
      .optional()
      .describe('Comma-separated CC recipients (email addresses)'),
    allow_self: z.boolean().optional().describe('Allow replying to self'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('draft_reply_all', args)),
);

server.tool(
  'add_labels',
  'Add labels to a message. Permission-gated (except claw/* labels).',
  {
    message_id: z.string().describe('Message ID'),
    labels: z.array(z.string()).describe('Label names to add'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('add_labels', args)),
);

server.tool(
  'remove_labels',
  'Remove labels from a message. Permission-gated (except claw/* labels).',
  {
    message_id: z.string().describe('Message ID'),
    labels: z.array(z.string()).describe('Label names to remove'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('remove_labels', args)),
);

server.tool(
  'archive_messages',
  'Archive emails (remove from inbox). Always allowed — this is non-destructive.',
  {
    message_ids: z.array(z.string()).describe('Message IDs to archive'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('archive_messages', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
