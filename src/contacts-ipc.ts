/**
 * Host-side Google Contacts IPC handler.
 *
 * Watches for request files from containers in {group}/contacts/requests/,
 * executes google_contacts_wrapper.py, and writes responses to {group}/contacts/responses/.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const CONTACTS_WRAPPER = path.join(SCRIPTS_DIR, 'google_contacts_wrapper.py');

interface ContactsRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function runContactsCmd(
  cmdArgs: string[],
  account: string = '1',
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [CONTACTS_WRAPPER, '--account', account, ...cmdArgs],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `google_contacts_wrapper error: ${stderr || error.message}`,
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

async function handleRequest(req: ContactsRequest): Promise<unknown> {
  const { tool, args } = req;
  const account = String(args.account || '1');

  switch (tool) {
    case 'list_contacts': {
      const cmdArgs = ['list'];
      if (args.page_size) cmdArgs.push('--page-size', String(args.page_size));
      if (args.page_token)
        cmdArgs.push('--page-token', String(args.page_token));
      return runContactsCmd(cmdArgs, account);
    }

    case 'get_contact': {
      if (!args.resource_name) throw new Error('resource_name is required');
      return runContactsCmd(
        ['get', '--resource-name', String(args.resource_name)],
        account,
      );
    }

    case 'search_contacts': {
      if (!args.query) throw new Error('query is required');
      const cmdArgs = ['search', '--query', String(args.query)];
      if (args.page_size) cmdArgs.push('--page-size', String(args.page_size));
      return runContactsCmd(cmdArgs, account);
    }

    case 'create_contact': {
      const cmdArgs = ['create'];
      if (args.given_name)
        cmdArgs.push('--given-name', String(args.given_name));
      if (args.family_name)
        cmdArgs.push('--family-name', String(args.family_name));
      if (args.email) cmdArgs.push('--email', String(args.email));
      if (args.phone) cmdArgs.push('--phone', String(args.phone));
      if (args.organization)
        cmdArgs.push('--organization', String(args.organization));
      if (args.title) cmdArgs.push('--title', String(args.title));
      if (args.notes) cmdArgs.push('--notes', String(args.notes));
      return runContactsCmd(cmdArgs, account);
    }

    case 'update_contact': {
      if (!args.resource_name) throw new Error('resource_name is required');
      if (!args.etag) throw new Error('etag is required');
      const cmdArgs = [
        'update',
        '--resource-name',
        String(args.resource_name),
        '--etag',
        String(args.etag),
      ];
      if (args.given_name !== undefined)
        cmdArgs.push('--given-name', String(args.given_name));
      if (args.family_name !== undefined)
        cmdArgs.push('--family-name', String(args.family_name));
      if (args.email !== undefined)
        cmdArgs.push('--email', String(args.email));
      if (args.phone !== undefined)
        cmdArgs.push('--phone', String(args.phone));
      if (args.organization !== undefined)
        cmdArgs.push('--organization', String(args.organization));
      if (args.title !== undefined)
        cmdArgs.push('--title', String(args.title));
      if (args.notes !== undefined)
        cmdArgs.push('--notes', String(args.notes));
      return runContactsCmd(cmdArgs, account);
    }

    case 'delete_contact': {
      if (!args.resource_name) throw new Error('resource_name is required');
      return runContactsCmd(
        ['delete', '--resource-name', String(args.resource_name)],
        account,
      );
    }

    default:
      throw new Error(`Unknown contacts tool: ${tool}`);
  }
}

/**
 * Process all pending Contacts IPC requests in a given group's IPC directory.
 */
export function processContactsIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'contacts', 'requests');
  const responsesDir = path.join(groupIpcDir, 'contacts', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: ContactsRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse contacts IPC request');
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
          'Contacts IPC error',
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
