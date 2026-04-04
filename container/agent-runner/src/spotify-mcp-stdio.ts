/**
 * Spotify MCP Server (container-side proxy)
 *
 * Exposes Spotify tools to the agent via IPC bridge.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'spotify', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'spotify', 'responses');
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
  throw new Error(
    `Spotify IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'spotify', version: '1.0.0' });

server.tool(
  'search_artists',
  'Search for artists on Spotify',
  {
    query: z.string().describe('Artist name to search for'),
    limit: z
      .number()
      .optional()
      .describe('Maximum number of results (default: 5)'),
  },
  async (args) => textResult(await ipcRequest('search_artists', args)),
);

server.tool(
  'get_artist',
  'Get details for a Spotify artist by ID',
  {
    artist_id: z.string().describe('Spotify artist ID'),
  },
  async (args) => textResult(await ipcRequest('get_artist', args)),
);

server.tool(
  'check_following',
  'Check if the user follows one or more artists',
  {
    artist_ids: z
      .union([
        z.string().describe('Comma-separated artist IDs'),
        z.array(z.string()).describe('Array of artist IDs'),
      ])
      .describe('Artist ID(s) to check'),
  },
  async (args) => textResult(await ipcRequest('check_following', args)),
);

server.tool(
  'follow_artist',
  'Follow an artist on Spotify (add to favorites)',
  {
    artist_id: z.string().describe('Spotify artist ID to follow'),
  },
  async (args) => textResult(await ipcRequest('follow_artist', args)),
);

server.tool(
  'unfollow_artist',
  'Unfollow an artist on Spotify',
  {
    artist_id: z.string().describe('Spotify artist ID to unfollow'),
  },
  async (args) => textResult(await ipcRequest('unfollow_artist', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
