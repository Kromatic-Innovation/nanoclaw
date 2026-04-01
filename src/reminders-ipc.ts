/**
 * Host-side Apple Reminders IPC handler.
 *
 * Watches for request files from containers in {group}/reminders/requests/,
 * executes JXA scripts via osascript, and writes responses to
 * {group}/reminders/responses/.
 *
 * This module runs on macOS only (requires osascript).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface RemindersRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run a JXA script via osascript and return the parsed JSON result.
 */
function runJxa<T>(script: string): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`JXA error: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as T);
        } catch {
          reject(
            new Error(`Failed to parse JXA output: ${stdout.slice(0, 500)}`),
          );
        }
      },
    );
  });
}

// --- JXA Scripts ---

const LIST_ALL_LISTS = `
  const app = Application("Reminders");
  const lists = app.lists();
  JSON.stringify(lists.map(l => ({
    id: l.id(),
    name: l.name()
  })));
`;

function GET_REMINDERS(listName: string, includeCompleted: boolean): string {
  return `
    const app = Application("Reminders");
    const list = app.lists.byName(${JSON.stringify(listName)});
    const reminders = list.reminders();
    const results = reminders
      .filter(r => ${includeCompleted ? 'true' : '!r.completed()'})
      .map(r => ({
        id: r.id(),
        name: r.name(),
        body: r.body(),
        completed: r.completed(),
        dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
        priority: r.priority(),
        flagged: r.flagged()
      }));
    JSON.stringify(results);
  `;
}

function CREATE_REMINDER(
  listName: string,
  name: string,
  opts: {
    body?: string;
    dueDate?: string;
    priority?: number;
    flagged?: boolean;
  },
): string {
  const props: string[] = [`name: ${JSON.stringify(name)}`];
  if (opts.body) props.push(`body: ${JSON.stringify(opts.body)}`);
  if (opts.dueDate)
    props.push(`dueDate: new Date(${JSON.stringify(opts.dueDate)})`);
  if (opts.priority !== undefined) props.push(`priority: ${opts.priority}`);
  if (opts.flagged !== undefined) props.push(`flagged: ${opts.flagged}`);

  return `
    const app = Application("Reminders");
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = app.Reminder({${props.join(', ')}});
    list.reminders.push(r);
    JSON.stringify({
      id: r.id(),
      name: r.name(),
      body: r.body(),
      completed: r.completed(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      priority: r.priority(),
      flagged: r.flagged()
    });
  `;
}

function COMPLETE_REMINDER(
  listName: string,
  reminderId: string,
  completed: boolean,
): string {
  return `
    const app = Application("Reminders");
    const list = app.lists.byName(${JSON.stringify(listName)});
    const reminders = list.reminders();
    const r = reminders.find(r => r.id() === ${JSON.stringify(reminderId)});
    if (!r) throw new Error("Reminder not found: " + ${JSON.stringify(reminderId)});
    r.completed = ${completed};
    JSON.stringify({
      id: r.id(),
      name: r.name(),
      completed: r.completed()
    });
  `;
}

function CREATE_LIST(name: string): string {
  return `
    const app = Application("Reminders");
    const list = app.ReminderList({name: ${JSON.stringify(name)}});
    app.lists.push(list);
    JSON.stringify({
      id: list.id(),
      name: list.name()
    });
  `;
}

function SEARCH_REMINDERS(query: string, includeCompleted: boolean): string {
  return `
    const app = Application("Reminders");
    const q = ${JSON.stringify(query.toLowerCase())};
    const results = [];
    const lists = app.lists();
    for (const list of lists) {
      const reminders = list.reminders();
      for (const r of reminders) {
        if (${includeCompleted ? 'true' : '!r.completed()'}) {
          const name = (r.name() || "").toLowerCase();
          const body = (r.body() || "").toLowerCase();
          if (name.includes(q) || body.includes(q)) {
            results.push({
              id: r.id(),
              name: r.name(),
              body: r.body(),
              completed: r.completed(),
              dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
              priority: r.priority(),
              flagged: r.flagged(),
              list: list.name()
            });
          }
        }
      }
    }
    JSON.stringify(results);
  `;
}

function GET_REMINDER_DETAIL(listName: string, reminderId: string): string {
  return `
    const app = Application("Reminders");
    const list = app.lists.byName(${JSON.stringify(listName)});
    const reminders = list.reminders();
    const r = reminders.find(r => r.id() === ${JSON.stringify(reminderId)});
    if (!r) throw new Error("Reminder not found: " + ${JSON.stringify(reminderId)});
    JSON.stringify({
      id: r.id(),
      name: r.name(),
      body: r.body(),
      completed: r.completed(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      completionDate: r.completionDate() ? r.completionDate().toISOString() : null,
      creationDate: r.creationDate() ? r.creationDate().toISOString() : null,
      modificationDate: r.modificationDate() ? r.modificationDate().toISOString() : null,
      priority: r.priority(),
      flagged: r.flagged()
    });
  `;
}

// --- Tool dispatcher ---

async function handleRequest(req: RemindersRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'list_reminder_lists':
      return runJxa(LIST_ALL_LISTS);

    case 'get_reminders':
      return runJxa(
        GET_REMINDERS(
          args.list as string,
          (args.include_completed as boolean) ?? false,
        ),
      );

    case 'create_reminder':
      return runJxa(
        CREATE_REMINDER(args.list as string, args.name as string, {
          body: args.body as string | undefined,
          dueDate: args.due_date as string | undefined,
          priority: args.priority as number | undefined,
          flagged: args.flagged as boolean | undefined,
        }),
      );

    case 'complete_reminder':
      return runJxa(
        COMPLETE_REMINDER(
          args.list as string,
          args.reminder_id as string,
          (args.completed as boolean) ?? true,
        ),
      );

    case 'create_list':
      return runJxa(CREATE_LIST(args.name as string));

    case 'search_reminders':
      return runJxa(
        SEARCH_REMINDERS(
          args.query as string,
          (args.include_completed as boolean) ?? false,
        ),
      );

    case 'get_reminder_detail':
      return runJxa(
        GET_REMINDER_DETAIL(args.list as string, args.reminder_id as string),
      );

    default:
      throw new Error(`Unknown reminders tool: ${tool}`);
  }
}

/**
 * Process all pending reminders IPC requests in a given group's IPC directory.
 */
export function processRemindersIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'reminders', 'requests');
  const responsesDir = path.join(groupIpcDir, 'reminders', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: RemindersRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse reminders IPC request');
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
          'Reminders IPC error',
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
