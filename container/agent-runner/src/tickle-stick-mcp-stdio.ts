/**
 * Tickle Stick MCP Server (container-side proxy)
 *
 * Exposes tickle-stick pipeline management tools to the agent via IPC bridge.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'tickle-stick', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'tickle-stick', 'responses');
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
    `Tickle-stick IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'tickle-stick', version: '1.0.0' });

server.tool(
  'list_pipelines',
  'List all tickle-stick triage pipelines',
  {},
  async () => textResult(await ipcRequest('list_pipelines', {})),
);

server.tool(
  'get_pipeline',
  'Get full definition of a tickle-stick pipeline',
  {
    name: z.string().describe('Pipeline name (e.g. "daily-briefing")'),
  },
  async (args) => textResult(await ipcRequest('get_pipeline', args)),
);

server.tool(
  'create_pipeline',
  'Create a new tickle-stick triage pipeline',
  {
    name: z.string().describe('Pipeline name (kebab-case)'),
    definition: z
      .string()
      .describe(
        'Pipeline definition as JSON string. Object with stages array. Each stage needs: name, type (script|model|callback), and type-specific fields.',
      ),
  },
  async (args) => {
    const parsed = JSON.parse(args.definition);
    return textResult(
      await ipcRequest('create_pipeline', {
        name: args.name,
        definition: parsed,
      }),
    );
  },
);

server.tool(
  'update_pipeline',
  'Update an existing tickle-stick triage pipeline',
  {
    name: z.string().describe('Pipeline name to update'),
    definition: z
      .string()
      .describe('New pipeline definition as JSON string (replaces existing)'),
  },
  async (args) => {
    const parsed = JSON.parse(args.definition);
    return textResult(
      await ipcRequest('update_pipeline', {
        name: args.name,
        definition: parsed,
      }),
    );
  },
);

server.tool(
  'delete_pipeline',
  'Delete a tickle-stick triage pipeline',
  {
    name: z.string().describe('Pipeline name to delete'),
  },
  async (args) => textResult(await ipcRequest('delete_pipeline', args)),
);

server.tool(
  'get_budget',
  'Get current tickle-stick budget configuration',
  {},
  async () => textResult(await ipcRequest('get_budget', {})),
);

const transport = new StdioServerTransport();
await server.connect(transport);
