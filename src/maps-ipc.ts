/**
 * Host-side Google Maps IPC handler.
 *
 * Watches for request files from containers in {group}/maps/requests/,
 * executes the google_maps_wrapper.py script, and writes responses to
 * {group}/maps/responses/.
 *
 * Uses the same Google OAuth credentials as calendar/gmail wrappers.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const MAPS_WRAPPER = path.join(SCRIPTS_DIR, 'google_maps_wrapper.py');

interface MapsRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function runMapsCmd(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [MAPS_WRAPPER, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`maps wrapper error: ${stderr || error.message}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (
            parsed &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            Object.keys(parsed).length === 1
          ) {
            reject(new Error(parsed.error));
            return;
          }
          resolve(parsed);
        } catch {
          resolve(trimmed);
        }
      },
    );
  });
}

async function handleRequest(req: MapsRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'get_directions': {
      if (!args.origin) throw new Error('origin is required');
      if (!args.destination) throw new Error('destination is required');
      const cmdArgs = [
        'directions',
        '--origin',
        String(args.origin),
        '--destination',
        String(args.destination),
      ];
      if (args.mode) cmdArgs.push('--mode', String(args.mode));
      if (args.departure) cmdArgs.push('--departure', String(args.departure));
      return runMapsCmd(cmdArgs);
    }

    case 'get_travel_time': {
      if (!args.origin) throw new Error('origin is required');
      if (!args.destination) throw new Error('destination is required');
      const cmdArgs = [
        'distance',
        '--origin',
        String(args.origin),
        '--destination',
        String(args.destination),
      ];
      if (args.mode) cmdArgs.push('--mode', String(args.mode));
      if (args.departure) cmdArgs.push('--departure', String(args.departure));
      return runMapsCmd(cmdArgs);
    }

    default:
      throw new Error(`Unknown maps tool: ${tool}`);
  }
}

export function processMapsIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'maps', 'requests');
  const responsesDir = path.join(groupIpcDir, 'maps', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: MapsRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse maps IPC request');
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
          'Maps IPC error',
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
