/**
 * Host-side Google Calendar IPC handler.
 *
 * Watches for request files from containers in {group}/calendar/requests/,
 * executes the google_calendar_wrapper.py script, and writes responses to
 * {group}/calendar/responses/.
 *
 * Requires Google OAuth credentials (loaded by the wrapper via 1Password or
 * credentials file).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const OPENCLAW_SCRIPTS = path.join(
  process.env.HOME || '',
  '.openclaw',
  'workspace',
  'scripts',
);
const CALENDAR_WRAPPER = path.join(
  OPENCLAW_SCRIPTS,
  'google_calendar_wrapper.py',
);

interface CalendarRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run the calendar wrapper script and return parsed JSON output.
 */
function runCalendarCmd(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [CALENDAR_WRAPPER, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`calendar wrapper error: ${stderr || error.message}`),
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

// --- Tool dispatcher ---

async function handleRequest(req: CalendarRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'list_calendars':
      return runCalendarCmd(['calendars']);

    case 'list_events': {
      const cmdArgs = ['list'];
      if (args.calendar) cmdArgs.push('--calendar', String(args.calendar));
      if (args.days) cmdArgs.push('--days', String(args.days));
      if (args.time_min) cmdArgs.push('--time-min', String(args.time_min));
      if (args.time_max) cmdArgs.push('--time-max', String(args.time_max));
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runCalendarCmd(cmdArgs);
    }

    case 'create_event': {
      const cmdArgs = ['create'];
      if (args.calendar) cmdArgs.push('--calendar', String(args.calendar));
      if (args.summary) cmdArgs.push('--summary', String(args.summary));
      if (args.description)
        cmdArgs.push('--description', String(args.description));
      if (args.location) cmdArgs.push('--location', String(args.location));
      if (args.start) cmdArgs.push('--start', String(args.start));
      if (args.end) cmdArgs.push('--end', String(args.end));
      return runCalendarCmd(cmdArgs);
    }

    case 'update_event': {
      if (!args.event_id)
        throw new Error('event_id is required for update_event');
      const cmdArgs = ['update', '--id', String(args.event_id)];
      if (args.calendar) cmdArgs.push('--calendar', String(args.calendar));
      if (args.summary) cmdArgs.push('--summary', String(args.summary));
      if (args.description)
        cmdArgs.push('--description', String(args.description));
      if (args.location) cmdArgs.push('--location', String(args.location));
      if (args.start) cmdArgs.push('--start', String(args.start));
      if (args.end) cmdArgs.push('--end', String(args.end));
      return runCalendarCmd(cmdArgs);
    }

    default:
      throw new Error(`Unknown calendar tool: ${tool}`);
  }
}

/**
 * Process all pending calendar IPC requests in a given group's IPC directory.
 */
export function processCalendarIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'calendar', 'requests');
  const responsesDir = path.join(groupIpcDir, 'calendar', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: CalendarRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse calendar IPC request');
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
          'Calendar IPC error',
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
