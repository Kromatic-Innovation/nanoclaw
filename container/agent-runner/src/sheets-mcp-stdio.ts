/**
 * Google Sheets MCP Server (container-side proxy)
 *
 * Exposes email triage spreadsheet tools to the agent via IPC bridge.
 * Manages contacts, tag rules, programmatic rules, and triage log.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'sheets', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'sheets', 'responses');
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
    `Sheets IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

const server = new McpServer({ name: 'google-sheets', version: '1.0.0' });

// --- Email Contacts (specific sender rules) ---

server.tool(
  'lookup_contact',
  'Look up a contact by email address. Returns tags, allowed actions, and drafting context.',
  {
    email: z.string().describe('Email address to look up'),
  },
  async (args) => textResult(await ipcRequest('lookup_contact', args)),
);

server.tool(
  'list_contacts',
  'List all contacts from the Email Contacts spreadsheet tab.',
  {},
  async () => textResult(await ipcRequest('list_contacts', {})),
);

server.tool(
  'add_contact',
  'Add a new contact to the Email Contacts tab. Use for sender-specific rules (e.g. "for emails from frank@esmt.org, draft a polite reply").',
  {
    email: z
      .string()
      .describe(
        'Email address or domain pattern (e.g. "frank@esmt.org" or "*@acme.com")',
      ),
    name: z.string().optional().describe('Contact name'),
    tags: z
      .string()
      .optional()
      .describe(
        'Comma-separated tags (e.g. "client,ai-friendly"). Tags map to allowed actions via Tag Rules.',
      ),
    allowed_actions: z
      .string()
      .optional()
      .describe(
        'Comma-separated actions (e.g. "draft,send"). Overrides tag-derived actions if set.',
      ),
    drafting_context: z
      .string()
      .optional()
      .describe(
        'Tone/style guidance for drafting replies to this contact (e.g. "polite business tone, use first name")',
      ),
    notes: z.string().optional().describe('Free-text notes about this contact'),
  },
  async (args) => textResult(await ipcRequest('add_contact', args)),
);

server.tool(
  'update_contact',
  'Update an existing contact in the Email Contacts tab.',
  {
    email: z.string().describe('Email of the contact to update'),
    name: z.string().optional().describe('Updated name'),
    tags: z.string().optional().describe('Updated tags (comma-separated)'),
    allowed_actions: z
      .string()
      .optional()
      .describe('Updated allowed actions (comma-separated)'),
    drafting_context: z
      .string()
      .optional()
      .describe('Updated drafting context'),
    notes: z.string().optional().describe('Updated notes'),
  },
  async (args) => textResult(await ipcRequest('update_contact', args)),
);

// --- Tag Rules (general category rules) ---

server.tool(
  'list_tag_rules',
  'List all tag-to-action mappings from the Tag Rules tab.',
  {},
  async () => textResult(await ipcRequest('list_tag_rules', {})),
);

server.tool(
  'add_tag_rule',
  'Add a new tag rule to the Tag Rules tab. Use for general category rules (e.g. "for all clients, allow drafting").',
  {
    tag: z.string().describe('Tag name (e.g. "client", "friend", "vendor")'),
    allowed_actions: z
      .string()
      .describe(
        'Comma-separated actions for this tag (e.g. "draft", "draft,send", "add-label,delete")',
      ),
    description: z
      .string()
      .optional()
      .describe('Human-readable description of this tag rule'),
  },
  async (args) => textResult(await ipcRequest('add_tag_rule', args)),
);

// --- Programmatic Rules (automatic pattern matching) ---

server.tool(
  'list_rules',
  'List all programmatic rules from the Programmatic Rules tab.',
  {},
  async () => textResult(await ipcRequest('list_rules', {})),
);

server.tool(
  'add_rule',
  'Add a programmatic rule to the Programmatic Rules tab. Use for automatic pattern-based classification (e.g. "emails from *.newsletter.com are mailing-list").',
  {
    condition: z
      .string()
      .describe(
        'Rule condition. Formats: "from_domain:<domain>", "from_email:<email>", "subject_contains:<keyword>", "has_unsubscribe:true"',
      ),
    action: z
      .string()
      .describe(
        'Category to assign when condition matches (e.g. "spam", "mailing-list", "urgent")',
      ),
    description: z
      .string()
      .optional()
      .describe('Human-readable description of what this rule does'),
    rule_id: z
      .string()
      .optional()
      .describe('Optional custom rule ID (auto-generated if omitted)'),
  },
  async (args) => textResult(await ipcRequest('add_rule', args)),
);

// --- Triage Log (audit trail) ---

server.tool(
  'get_triage_log',
  'Read recent triage log entries to review what the daily briefing pipeline did.',
  {
    limit: z
      .number()
      .optional()
      .describe('Maximum entries to return (default: 20)'),
  },
  async (args) => textResult(await ipcRequest('get_triage_log', args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
