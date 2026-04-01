/**
 * Host-side Google Sheets IPC handler.
 *
 * Watches for request files from containers in {group}/sheets/requests/,
 * executes sheets_contact_db.py, and writes responses to {group}/sheets/responses/.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const SHEETS_SCRIPT = path.join(SCRIPTS_DIR, 'sheets_contact_db.py');
const SHEETS_WRAPPER = path.join(SCRIPTS_DIR, 'google_sheets_wrapper.py');

interface SheetsRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function runSheetsCmd(cmdArgs: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SHEETS_SCRIPT, ...cmdArgs],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`sheets_contact_db error: ${stderr || error.message}`),
          );
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          resolve(trimmed);
        }
      },
    );
  });
}

function runSheetsWrapper(cmdArgs: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SHEETS_WRAPPER, ...cmdArgs],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `google_sheets_wrapper error: ${stderr || error.message}`,
            ),
          );
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          resolve(trimmed);
        }
      },
    );
  });
}

async function handleRequest(req: SheetsRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'lookup_contact': {
      if (!args.email) throw new Error('email is required');
      return runSheetsCmd(['lookup', String(args.email)]);
    }

    case 'list_contacts':
      return runSheetsCmd(['list-contacts']);

    case 'add_contact': {
      if (!args.email) throw new Error('email is required');
      const data: Record<string, string> = {
        email: String(args.email),
      };
      if (args.name) data.name = String(args.name);
      if (args.tags) data.tags = String(args.tags);
      if (args.allowed_actions)
        data.allowed_actions = String(args.allowed_actions);
      if (args.drafting_context)
        data.drafting_context = String(args.drafting_context);
      if (args.notes) data.notes = String(args.notes);
      return runSheetsCmd(['add-contact', JSON.stringify(data)]);
    }

    case 'update_contact': {
      if (!args.email) throw new Error('email is required');
      const updates: Record<string, string> = {};
      if (args.name !== undefined) updates.name = String(args.name);
      if (args.tags !== undefined) updates.tags = String(args.tags);
      if (args.allowed_actions !== undefined)
        updates.allowed_actions = String(args.allowed_actions);
      if (args.drafting_context !== undefined)
        updates.drafting_context = String(args.drafting_context);
      if (args.notes !== undefined) updates.notes = String(args.notes);
      return runSheetsCmd([
        'update-contact',
        String(args.email),
        JSON.stringify(updates),
      ]);
    }

    case 'list_tag_rules':
      return runSheetsCmd(['list-tag-rules']);

    case 'add_tag_rule': {
      if (!args.tag) throw new Error('tag is required');
      if (!args.allowed_actions) throw new Error('allowed_actions is required');
      const data: Record<string, string> = {
        tag: String(args.tag),
        allowed_actions: String(args.allowed_actions),
      };
      if (args.description) data.description = String(args.description);
      return runSheetsCmd(['add-tag-rule', JSON.stringify(data)]);
    }

    case 'list_rules':
      return runSheetsCmd(['list-programmatic-rules']);

    case 'add_rule': {
      if (!args.condition) throw new Error('condition is required');
      if (!args.action) throw new Error('action is required');
      const data: Record<string, string> = {
        condition: String(args.condition),
        action: String(args.action),
      };
      if (args.description) data.description = String(args.description);
      if (args.rule_id) data.rule_id = String(args.rule_id);
      return runSheetsCmd(['add-programmatic-rule', JSON.stringify(data)]);
    }

    case 'get_triage_log': {
      const cmdArgs = ['get-triage-log'];
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runSheetsCmd(cmdArgs);
    }

    // --- General-purpose spreadsheet operations ---

    case 'create_spreadsheet': {
      if (!args.title) throw new Error('title is required');
      const cmdArgs = ['create', '--title', String(args.title)];
      if (args.sheets) cmdArgs.push('--sheets', String(args.sheets));
      return runSheetsWrapper(cmdArgs);
    }

    case 'read_range': {
      if (!args.spreadsheet_id) throw new Error('spreadsheet_id is required');
      if (!args.range) throw new Error('range is required');
      return runSheetsWrapper([
        'read',
        '--spreadsheet-id',
        String(args.spreadsheet_id),
        '--range',
        String(args.range),
      ]);
    }

    case 'write_range': {
      if (!args.spreadsheet_id) throw new Error('spreadsheet_id is required');
      if (!args.range) throw new Error('range is required');
      if (!args.data) throw new Error('data is required');
      const cmdArgs = [
        'write',
        '--spreadsheet-id',
        String(args.spreadsheet_id),
        '--range',
        String(args.range),
        '--data',
        typeof args.data === 'string' ? args.data : JSON.stringify(args.data),
      ];
      if (args.input_option)
        cmdArgs.push('--input-option', String(args.input_option));
      return runSheetsWrapper(cmdArgs);
    }

    case 'append_rows': {
      if (!args.spreadsheet_id) throw new Error('spreadsheet_id is required');
      if (!args.sheet) throw new Error('sheet is required');
      if (!args.data) throw new Error('data is required');
      const cmdArgs = [
        'append',
        '--spreadsheet-id',
        String(args.spreadsheet_id),
        '--sheet',
        String(args.sheet),
        '--data',
        typeof args.data === 'string' ? args.data : JSON.stringify(args.data),
      ];
      if (args.input_option)
        cmdArgs.push('--input-option', String(args.input_option));
      return runSheetsWrapper(cmdArgs);
    }

    case 'list_sheets': {
      if (!args.spreadsheet_id) throw new Error('spreadsheet_id is required');
      return runSheetsWrapper([
        'list-sheets',
        '--spreadsheet-id',
        String(args.spreadsheet_id),
      ]);
    }

    case 'add_sheet': {
      if (!args.spreadsheet_id) throw new Error('spreadsheet_id is required');
      if (!args.title) throw new Error('title is required');
      return runSheetsWrapper([
        'add-sheet',
        '--spreadsheet-id',
        String(args.spreadsheet_id),
        '--title',
        String(args.title),
      ]);
    }

    default:
      throw new Error(`Unknown sheets tool: ${tool}`);
  }
}

/**
 * Process all pending Sheets IPC requests in a given group's IPC directory.
 */
export function processSheetsIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'sheets', 'requests');
  const responsesDir = path.join(groupIpcDir, 'sheets', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: SheetsRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse sheets IPC request');
      fs.unlinkSync(requestPath);
      continue;
    }

    fs.unlinkSync(requestPath);

    handleRequest(req)
      .then((result) => {
        writeResponse(responsesDir, req.id, { result });
      })
      .catch((err) => {
        logger.error(
          { requestId: req.id, tool: req.tool, err },
          'Sheets IPC error',
        );
        writeResponse(responsesDir, req.id, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

function writeResponse(
  responsesDir: string,
  requestId: string,
  data: { result?: unknown; error?: string },
): void {
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, responsePath);
}
