/**
 * Host-side Google Drive IPC handler.
 *
 * Watches for request files from containers in {group}/drive/requests/,
 * executes google_drive_wrapper.py, and writes responses to
 * {group}/drive/responses/.
 *
 * All read operations go directly to google_drive_wrapper.py.
 * Upload goes directly too (no action guard needed for Drive).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const DRIVE_WRAPPER = path.join(SCRIPTS_DIR, 'google_drive_wrapper.py');

interface DriveRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run a Drive command via the wrapper script.
 */
function runDriveCmd(
  wrapperArgs: string[],
  account: string = '1',
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [DRIVE_WRAPPER, '--account', account, ...wrapperArgs],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`drive wrapper error: ${stderr || error.message}`));
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

async function handleRequest(req: DriveRequest): Promise<unknown> {
  const { tool, args } = req;
  const account = String(args.account || '1');

  switch (tool) {
    case 'list_files': {
      const cmdArgs = ['list'];
      if (args.query) cmdArgs.push('--query', String(args.query));
      if (args.folder_id) cmdArgs.push('--folder-id', String(args.folder_id));
      if (args.max_results)
        cmdArgs.push('--max-results', String(args.max_results));
      return runDriveCmd(cmdArgs, account);
    }

    case 'get_file': {
      if (!args.file_id) throw new Error('file_id is required');
      return runDriveCmd(['get', '--id', String(args.file_id)], account);
    }

    case 'read_file': {
      if (!args.file_id) throw new Error('file_id is required');
      return runDriveCmd(['read', '--id', String(args.file_id)], account);
    }

    case 'search_files': {
      if (!args.query) throw new Error('query is required');
      const cmdArgs = ['search', '--query', String(args.query)];
      if (args.max_results)
        cmdArgs.push('--max-results', String(args.max_results));
      return runDriveCmd(cmdArgs, account);
    }

    case 'upload_file': {
      if (!args.file_path) throw new Error('file_path is required');
      const cmdArgs = ['upload', '--file', String(args.file_path)];
      if (args.folder_id) cmdArgs.push('--folder-id', String(args.folder_id));
      return runDriveCmd(cmdArgs, account);
    }

    case 'move_file': {
      if (!args.file_id) throw new Error('file_id is required');
      if (!args.to_folder_id) throw new Error('to_folder_id is required');
      return runDriveCmd(
        ['move', '--id', String(args.file_id), '--to-folder-id', String(args.to_folder_id)],
        account,
      );
    }

    default:
      throw new Error(`Unknown drive tool: ${tool}`);
  }
}

/**
 * Process all pending Drive IPC requests in a given group's IPC directory.
 */
export function processDriveIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'drive', 'requests');
  const responsesDir = path.join(groupIpcDir, 'drive', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: DriveRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse drive IPC request');
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
          'Drive IPC error',
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
