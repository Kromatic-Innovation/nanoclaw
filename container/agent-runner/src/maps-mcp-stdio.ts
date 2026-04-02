/**
 * Google Maps MCP Server (container-side proxy)
 *
 * Exposes Maps tools to the agent via IPC bridge.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'maps', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'maps', 'responses');
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
  throw new Error(`Maps IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`);
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

const server = new McpServer({ name: 'google-maps', version: '1.0.0' });

server.tool(
  'get_directions',
  'Get full route directions between two locations',
  {
    origin: z.string().describe('Starting address or place name'),
    destination: z.string().describe('Destination address or place name'),
    mode: z
      .enum(['drive', 'transit', 'walk', 'bicycle'])
      .default('drive')
      .describe('Travel mode'),
    departure: z
      .string()
      .optional()
      .describe('Departure time (ISO 8601) for traffic-aware estimates'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_directions', args)),
);

server.tool(
  'get_travel_time',
  'Get travel time and distance between two locations (summary only)',
  {
    origin: z.string().describe('Starting address or place name'),
    destination: z.string().describe('Destination address or place name'),
    mode: z
      .enum(['drive', 'transit', 'walk', 'bicycle'])
      .default('drive')
      .describe('Travel mode'),
    departure: z
      .string()
      .optional()
      .describe('Departure time (ISO 8601) for traffic-aware estimates'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_travel_time', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
