/**
 * Google Contacts MCP Server (container-side proxy)
 *
 * Exposes Google Contacts (People API) tools to the agent via IPC bridge.
 * Supports multi-account selection via optional `account` parameter.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'contacts', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'contacts', 'responses');
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
    `Contacts IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
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
  .describe(
    'Google account to use: "1" (default/primary) or "2" (secondary)',
  );

const server = new McpServer({ name: 'google-contacts', version: '1.0.0' });

server.tool(
  'list_contacts',
  'List Google Contacts. Returns names, emails, phones, organizations, and notes. Supports pagination.',
  {
    page_size: z
      .number()
      .optional()
      .describe('Number of contacts per page (default: 100, max: 1000)'),
    page_token: z
      .string()
      .optional()
      .describe('Token for the next page of results (from a previous list call)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('list_contacts', args)),
);

server.tool(
  'get_contact',
  'Get a single Google Contact by resource name. Returns full contact details including etag (needed for updates).',
  {
    resource_name: z
      .string()
      .describe('Contact resource name (e.g. "people/c123456789")'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_contact', args)),
);

server.tool(
  'search_contacts',
  'Search Google Contacts by name, email, or phone number.',
  {
    query: z.string().describe('Search query (matches name, email, phone)'),
    page_size: z
      .number()
      .optional()
      .describe('Max results to return (default: 30)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('search_contacts', args)),
);

server.tool(
  'create_contact',
  'Create a new Google Contact. Provide at least a name or email.',
  {
    given_name: z.string().optional().describe('First name'),
    family_name: z.string().optional().describe('Last name'),
    email: z.string().optional().describe('Email address'),
    phone: z.string().optional().describe('Phone number'),
    organization: z.string().optional().describe('Company/organization name'),
    title: z.string().optional().describe('Job title'),
    notes: z.string().optional().describe('Notes about this contact'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('create_contact', args)),
);

server.tool(
  'update_contact',
  'Update an existing Google Contact. Requires the resource_name and etag (get these from get_contact or list_contacts first). Only provided fields are updated.',
  {
    resource_name: z
      .string()
      .describe('Contact resource name (e.g. "people/c123456789")'),
    etag: z
      .string()
      .describe(
        'Contact etag from get_contact/list_contacts (required for concurrency control)',
      ),
    given_name: z.string().optional().describe('Updated first name'),
    family_name: z.string().optional().describe('Updated last name'),
    email: z.string().optional().describe('Updated email address'),
    phone: z.string().optional().describe('Updated phone number'),
    organization: z
      .string()
      .optional()
      .describe('Updated company/organization'),
    title: z.string().optional().describe('Updated job title'),
    notes: z.string().optional().describe('Updated notes'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('update_contact', args)),
);

server.tool(
  'delete_contact',
  'Delete a Google Contact by resource name. This action cannot be undone.',
  {
    resource_name: z
      .string()
      .describe('Contact resource name to delete (e.g. "people/c123456789")'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('delete_contact', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
