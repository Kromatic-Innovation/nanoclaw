/**
 * Host-side Google Docs IPC handler.
 *
 * Watches for request files from containers in {group}/docs/requests/,
 * executes the google_docs_wrapper.py script, and writes responses to
 * {group}/docs/responses/.
 *
 * Requires Google OAuth credentials (loaded by the wrapper via 1Password or
 * credentials file).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const DOCS_WRAPPER = path.join(SCRIPTS_DIR, 'google_docs_wrapper.py');

interface DocsRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run the docs wrapper script and return parsed JSON output.
 */
function runDocsCmd(args: string[], account: string = '1'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [DOCS_WRAPPER, '--account', account, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`google_docs_wrapper error: ${stderr || error.message}`),
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

async function handleRequest(req: DocsRequest): Promise<unknown> {
  const { tool, args } = req;
  const account = String(args.account || '1');

  switch (tool) {
    case 'get_document': {
      if (!args.document_id)
        throw new Error('document_id is required for get_document');
      return runDocsCmd(['get', '--doc-id', String(args.document_id)], account);
    }

    case 'create_document': {
      if (!args.title) throw new Error('title is required for create_document');
      const cmdArgs = ['create', '--title', String(args.title)];
      if (args.body) cmdArgs.push('--body', String(args.body));
      return runDocsCmd(cmdArgs, account);
    }

    case 'append_to_document': {
      if (!args.document_id)
        throw new Error('document_id is required for append_to_document');
      if (!args.text)
        throw new Error('text is required for append_to_document');
      return runDocsCmd(
        [
          'append',
          '--doc-id',
          String(args.document_id),
          '--text',
          String(args.text),
        ],
        account,
      );
    }

    case 'search_documents': {
      if (!args.query)
        throw new Error('query is required for search_documents');
      const cmdArgs = ['search', '--query', String(args.query)];
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runDocsCmd(cmdArgs, account);
    }

    case 'list_documents': {
      const cmdArgs = ['list'];
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runDocsCmd(cmdArgs, account);
    }

    default:
      throw new Error(`Unknown docs tool: ${tool}`);
  }
}

/**
 * Process all pending Docs IPC requests in a given group's IPC directory.
 */
export function processDocsIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'docs', 'requests');
  const responsesDir = path.join(groupIpcDir, 'docs', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: DocsRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse docs IPC request');
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
          'Docs IPC error',
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
