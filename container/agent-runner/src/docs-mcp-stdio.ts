/**
 * Google Docs MCP Server (container-side proxy)
 *
 * Exposes Google Docs tools to the agent via IPC bridge.
 * Writes requests to /workspace/ipc/docs/requests/
 * Polls for responses at /workspace/ipc/docs/responses/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'docs', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'docs', 'responses');
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
  throw new Error(`Docs IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`);
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

const server = new McpServer({ name: 'google-docs', version: '1.0.0' });

server.tool(
  'get_document',
  'Get a Google Doc by ID. Returns title, metadata, and full text content.',
  {
    document_id: z.string().describe('The Google Doc document ID'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_document', args)),
);

server.tool(
  'create_document',
  'Create a new Google Doc with a title and optional initial body text.',
  {
    title: z.string().describe('Title for the new document'),
    body: z
      .string()
      .optional()
      .describe('Initial body text to insert into the document'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('create_document', args)),
);

server.tool(
  'append_to_document',
  'Append text to the end of an existing Google Doc.',
  {
    document_id: z.string().describe('The Google Doc document ID'),
    text: z.string().describe('Text to append to the end of the document'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('append_to_document', args)),
);

server.tool(
  'search_documents',
  'Search for Google Docs by name or content. Uses the Drive API to find matching documents.',
  {
    query: z
      .string()
      .describe('Search query (matches document name and content)'),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of results to return (default: 10)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('search_documents', args)),
);

server.tool(
  'list_documents',
  'List recent Google Docs, ordered by last modified time.',
  {
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of documents to return (default: 10)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('list_documents', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
