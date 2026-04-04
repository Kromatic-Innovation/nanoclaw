/**
 * Stdio MCP Server for NanoClaw Service Management
 * Standalone process that exposes service restart/reload/status tools.
 * Uses file-based IPC to communicate with the host process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'service', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'service', 'responses');
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
    `Service IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'nanoclaw-service', version: '1.0.0' });

server.tool(
  'restart_service',
  'Restart the nanoclaw service. The service will finish current requests before restarting. Main group only.',
  {
    reason: z
      .string()
      .describe(
        'Reason for the restart (logged for audit trail). Be specific.',
      ),
  },
  async (args) => textResult(await ipcRequest('restart_service', args)),
);

server.tool(
  'reload_config',
  'Reload nanoclaw configuration without a full restart. Sends SIGHUP to the service process. Main group only.',
  {
    reason: z
      .string()
      .describe(
        'Reason for the config reload (logged for audit trail). Be specific.',
      ),
  },
  async (args) => textResult(await ipcRequest('reload_config', args)),
);

server.tool(
  'get_service_status',
  'Check the current status of the nanoclaw service. Returns uptime, version, PID, and service manager status.',
  {},
  async () => textResult(await ipcRequest('get_service_status', {})),
);

const transport = new StdioServerTransport();
await server.connect(transport);
