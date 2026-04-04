/**
 * Google Drive MCP Server (container-side proxy)
 *
 * Exposes Google Drive tools to the agent via IPC bridge.
 * Writes requests to /workspace/ipc/drive/requests/
 * Polls for responses at /workspace/ipc/drive/responses/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'drive', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'drive', 'responses');
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
  throw new Error(`Drive IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`);
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

const server = new McpServer({ name: 'google-drive', version: '1.0.0' });

server.tool(
  'list_files',
  'List files in Google Drive with optional query filter and folder scope',
  {
    query: z
      .string()
      .optional()
      .describe('Drive query filter (e.g. "mimeType=\'application/pdf\'")'),
    folder_id: z
      .string()
      .optional()
      .describe('Parent folder ID to list files from'),
    max_results: z
      .number()
      .optional()
      .describe('Maximum number of files to return (default: 20)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('list_files', args)),
);

server.tool(
  'get_file',
  'Get file metadata by ID (name, type, size, modified time, etc.)',
  {
    file_id: z.string().describe('Google Drive file ID'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_file', args)),
);

server.tool(
  'read_file',
  'Download and read the content of a text-based file by ID. Google Workspace files (Docs, Sheets, Slides) are automatically exported.',
  {
    file_id: z.string().describe('Google Drive file ID'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('read_file', args)),
);

server.tool(
  'search_files',
  'Search files in Google Drive by name or content',
  {
    query: z
      .string()
      .describe('Search query (searches file names and content)'),
    max_results: z
      .number()
      .optional()
      .describe('Maximum number of results to return (default: 20)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('search_files', args)),
);

server.tool(
  'move_file',
  'Move a file to a different folder in Google Drive',
  {
    file_id: z.string().describe('Google Drive file ID'),
    to_folder_id: z.string().describe('Destination folder ID'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('move_file', args)),
);

server.tool(
  'upload_file',
  'Upload a file to Google Drive',
  {
    file_path: z.string().describe('Local file path to upload'),
    folder_id: z
      .string()
      .optional()
      .describe('Target folder ID (uploads to root if not specified)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('upload_file', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
