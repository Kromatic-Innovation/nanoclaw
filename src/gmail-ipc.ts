/**
 * Host-side Gmail IPC handler.
 *
 * Watches for request files from containers in {group}/gmail/requests/,
 * executes gmail_wrapper.py (via email-action-guard.py for mutating ops),
 * and writes responses to {group}/gmail/responses/.
 *
 * Read-only operations (list, get, thread, labels) go directly to
 * gmail_wrapper.py. Mutating operations (send, draft, label changes) go
 * through email-action-guard.py for permission enforcement.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const GMAIL_WRAPPER = path.join(SCRIPTS_DIR, 'gmail_wrapper.py');
const EMAIL_ACTION_GUARD = path.join(SCRIPTS_DIR, 'email-action-guard.py');

// Commands that bypass the action guard (read-only)
const READ_ONLY_COMMANDS = new Set([
  'list',
  'get',
  'thread',
  'labels',
  'label-create',
  'get-attachment',
]);

interface GmailRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run a gmail command. Mutating commands go through email-action-guard.py,
 * read-only commands go directly to gmail_wrapper.py.
 */
function runGmailCmd(
  wrapperArgs: string[],
  guarded: boolean,
  account: string = '1',
): Promise<unknown> {
  const script = guarded ? EMAIL_ACTION_GUARD : GMAIL_WRAPPER;
  const accountArgs = ['--account', account];
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [script, ...accountArgs, ...wrapperArgs],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: { ...process.env, GMAIL_WRAPPER_PATH: GMAIL_WRAPPER },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Check if this is a permission block from the guard
          const combined = (stderr || '') + (stdout || '');
          if (combined.includes('action_blocked')) {
            try {
              const blocked = JSON.parse(stdout.trim());
              reject(
                new Error(
                  `Permission denied: ${blocked.reason || 'action blocked by email-action-guard'}`,
                ),
              );
              return;
            } catch {
              // fall through to generic error
            }
          }
          reject(new Error(`gmail wrapper error: ${stderr || error.message}`));
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

// --- Tool dispatcher ---

async function handleRequest(req: GmailRequest): Promise<unknown> {
  const { tool, args } = req;
  const account = String(args.account || '1');

  switch (tool) {
    // Read-only operations (no guard)
    case 'list_messages': {
      const cmdArgs = ['list'];
      if (args.query) cmdArgs.push('--query', String(args.query));
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runGmailCmd(cmdArgs, false, account);
    }

    case 'get_message': {
      if (!args.message_id) throw new Error('message_id is required');
      const cmdArgs = ['get', '--id', String(args.message_id)];
      if (args.format) cmdArgs.push('--format', String(args.format));
      return runGmailCmd(cmdArgs, false, account);
    }

    case 'get_thread': {
      if (!args.message_id) throw new Error('message_id is required');
      return runGmailCmd(
        ['thread', '--id', String(args.message_id)],
        false,
        account,
      );
    }

    case 'list_labels':
      return runGmailCmd(['labels'], false, account);

    case 'create_label': {
      if (!args.name) throw new Error('name is required');
      return runGmailCmd(
        ['label-create', '--name', String(args.name)],
        false,
        account,
      );
    }

    case 'get_attachment': {
      if (!args.message_id) throw new Error('message_id is required');
      if (!args.attachment_id) throw new Error('attachment_id is required');
      return runGmailCmd(
        [
          'get-attachment',
          '--message-id',
          String(args.message_id),
          '--attachment-id',
          String(args.attachment_id),
        ],
        false,
        account,
      );
    }

    // Mutating operations (through action guard)
    case 'send_new': {
      if (!args.to) throw new Error('to is required');
      if (!args.subject) throw new Error('subject is required');
      if (!args.body) throw new Error('body is required');
      return runGmailCmd(
        [
          'send-new',
          '--to',
          String(args.to),
          '--subject',
          String(args.subject),
          '--body',
          String(args.body),
        ],
        true,
        account,
      );
    }

    case 'send_with_attachment': {
      if (!args.to) throw new Error('to is required');
      if (!args.subject) throw new Error('subject is required');
      if (!args.body) throw new Error('body is required');
      if (!args.attachment_path) throw new Error('attachment_path is required');
      const cmdArgs = [
        'send-with-attachment',
        '--to',
        String(args.to),
        '--subject',
        String(args.subject),
        '--body',
        String(args.body),
        '--attachment-path',
        String(args.attachment_path),
      ];
      if (args.attachment_name)
        cmdArgs.push('--attachment-name', String(args.attachment_name));
      return runGmailCmd(cmdArgs, true, account);
    }

    case 'send_reply_all': {
      if (!args.message_id) throw new Error('message_id is required');
      if (!args.body) throw new Error('body is required');
      const cmdArgs = [
        'send-reply-all',
        '--id',
        String(args.message_id),
        '--body',
        String(args.body),
      ];
      if (args.cc) cmdArgs.push('--cc', String(args.cc));
      if (args.bcc) cmdArgs.push('--bcc', String(args.bcc));
      if (args.allow_self) cmdArgs.push('--allow-self');
      return runGmailCmd(cmdArgs, true, account);
    }

    case 'draft_new': {
      if (!args.to) throw new Error('to is required');
      if (!args.subject) throw new Error('subject is required');
      if (!args.body) throw new Error('body is required');
      return runGmailCmd(
        [
          'draft-new',
          '--to',
          String(args.to),
          '--subject',
          String(args.subject),
          '--body',
          String(args.body),
        ],
        true,
        account,
      );
    }

    case 'draft_reply': {
      if (!args.message_id) throw new Error('message_id is required');
      if (!args.body) throw new Error('body is required');
      return runGmailCmd(
        [
          'draft-reply',
          '--id',
          String(args.message_id),
          '--body',
          String(args.body),
        ],
        true,
        account,
      );
    }

    case 'draft_reply_all': {
      if (!args.message_id) throw new Error('message_id is required');
      if (!args.body) throw new Error('body is required');
      const cmdArgs = [
        'draft-reply-all',
        '--id',
        String(args.message_id),
        '--body',
        String(args.body),
      ];
      if (args.cc) cmdArgs.push('--cc', String(args.cc));
      if (args.bcc) cmdArgs.push('--bcc', String(args.bcc));
      if (args.allow_self) cmdArgs.push('--allow-self');
      return runGmailCmd(cmdArgs, true, account);
    }

    case 'add_labels': {
      if (!args.message_id) throw new Error('message_id is required');
      if (
        !args.labels ||
        !Array.isArray(args.labels) ||
        args.labels.length === 0
      )
        throw new Error('labels array is required');
      return runGmailCmd(
        [
          'label-add',
          '--id',
          String(args.message_id),
          '--labels',
          ...args.labels.map(String),
        ],
        true,
        account,
      );
    }

    case 'remove_labels': {
      if (!args.message_id) throw new Error('message_id is required');
      if (
        !args.labels ||
        !Array.isArray(args.labels) ||
        args.labels.length === 0
      )
        throw new Error('labels array is required');
      return runGmailCmd(
        [
          'label-remove',
          '--id',
          String(args.message_id),
          '--labels',
          ...args.labels.map(String),
        ],
        true,
        account,
      );
    }

    case 'archive_messages': {
      if (
        !args.message_ids ||
        !Array.isArray(args.message_ids) ||
        args.message_ids.length === 0
      )
        throw new Error('message_ids array is required');
      // Archive = remove INBOX label. Non-destructive, bypasses guard.
      const results = [];
      for (const msgId of args.message_ids) {
        try {
          const result = await runGmailCmd(
            ['label-remove', '--id', String(msgId), '--labels', 'INBOX'],
            false,
            account,
          );
          results.push({ message_id: msgId, status: 'archived', result });
        } catch (err) {
          results.push({
            message_id: msgId,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    }

    default:
      throw new Error(`Unknown gmail tool: ${tool}`);
  }
}

/**
 * Process all pending Gmail IPC requests in a given group's IPC directory.
 */
export function processGmailIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'gmail', 'requests');
  const responsesDir = path.join(groupIpcDir, 'gmail', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: GmailRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse gmail IPC request');
      fs.unlinkSync(requestPath);
      continue;
    }

    // Delete the request file immediately to avoid reprocessing
    fs.unlinkSync(requestPath);

    // Process async — write response when done
    handleRequest(req)
      .then((result) => {
        writeResponse(responsesDir, req.id, { result });
      })
      .catch((err) => {
        logger.error(
          { requestId: req.id, tool: req.tool, err },
          'Gmail IPC error',
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
