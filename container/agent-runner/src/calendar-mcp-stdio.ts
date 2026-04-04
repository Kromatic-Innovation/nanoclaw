/**
 * Google Calendar MCP Server (container-side proxy)
 *
 * Exposes Calendar tools to the agent via IPC bridge.
 * Writes requests to /workspace/ipc/calendar/requests/
 * Polls for responses at /workspace/ipc/calendar/responses/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'calendar', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'calendar', 'responses');
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
    `Calendar IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
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
  .describe('Google account to use: "1" (default/primary) or "2" (secondary)');

const server = new McpServer({ name: 'google-calendar', version: '1.0.0' });

server.tool(
  'list_calendars',
  'List all Google Calendar calendars',
  { account: accountParam },
  async (args) => textResult(await ipcRequest('list_calendars', args)),
);

server.tool(
  'list_events',
  'List upcoming calendar events',
  {
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    days: z.number().optional().describe('Number of days to look ahead'),
    time_min: z.string().optional().describe('Start of time range (ISO 8601)'),
    time_max: z.string().optional().describe('End of time range (ISO 8601)'),
    query: z
      .string()
      .optional()
      .describe(
        'Free-text search query (matches title, description, location, attendees)',
      ),
    limit: z.number().optional().describe('Maximum number of events to return'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('list_events', args)),
);

server.tool(
  'create_event',
  'Create a new calendar event',
  {
    summary: z.string().describe('Event title'),
    start: z
      .string()
      .describe('Start time (ISO 8601, e.g. 2026-04-01T10:00:00-04:00)'),
    end: z.string().describe('End time (ISO 8601)'),
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    free: z
      .boolean()
      .optional()
      .describe('Show as Free (true) or Busy (false, default)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('create_event', args)),
);

server.tool(
  'update_event',
  'Update an existing calendar event',
  {
    event_id: z.string().describe('Event ID to update'),
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    summary: z.string().optional().describe('New event title'),
    start: z.string().optional().describe('New start time (ISO 8601)'),
    end: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    free: z
      .boolean()
      .optional()
      .describe('Show as Free (true) or Busy (false/default)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('update_event', args)),
);

server.tool(
  'delete_event',
  'Delete a calendar event by ID. This permanently removes the event.',
  {
    event_id: z.string().describe('Event ID to delete'),
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('delete_event', args)),
);

server.tool(
  'get_event',
  'Get full details of a calendar event including attendee response status and counter-proposals',
  {
    event_id: z.string().describe('Event ID to retrieve'),
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('get_event', args)),
);

server.tool(
  'search_events',
  'Search calendar events by text query',
  {
    query: z.string().describe('Free-text search query'),
    calendar: z
      .string()
      .default('primary')
      .describe('Calendar ID (default: primary)'),
    days: z.number().optional().describe('Number of days to search ahead'),
    time_min: z.string().optional().describe('Start of time range (ISO 8601)'),
    time_max: z.string().optional().describe('End of time range (ISO 8601)'),
    account: accountParam,
  },
  async (args) => textResult(await ipcRequest('search_events', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
