/**
 * Host-side Spotify IPC handler.
 *
 * Watches for request files from containers in {group}/spotify/requests/,
 * executes the spotify_wrapper.py script, and writes responses to
 * {group}/spotify/responses/.
 *
 * Auth credentials resolved by the wrapper from macOS Keychain.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const SPOTIFY_WRAPPER = path.join(SCRIPTS_DIR, 'spotify_wrapper.py');

interface SpotifyRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function runSpotifyCmd(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [SPOTIFY_WRAPPER, ...args],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`spotify wrapper error: ${stderr || error.message}`),
          );
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

async function handleRequest(req: SpotifyRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'search_artists': {
      if (!args.query) throw new Error('query is required');
      const cmdArgs = [
        'search',
        '--query',
        String(args.query),
        '--type',
        'artist',
      ];
      if (args.limit) cmdArgs.push('--limit', String(args.limit));
      return runSpotifyCmd(cmdArgs);
    }

    case 'get_artist': {
      if (!args.artist_id) throw new Error('artist_id is required');
      return runSpotifyCmd(['artist', '--id', String(args.artist_id)]);
    }

    case 'check_following': {
      if (!args.artist_ids) throw new Error('artist_ids is required');
      const ids = Array.isArray(args.artist_ids)
        ? args.artist_ids.join(',')
        : String(args.artist_ids);
      return runSpotifyCmd(['following', '--ids', ids]);
    }

    case 'follow_artist': {
      if (!args.artist_id) throw new Error('artist_id is required');
      return runSpotifyCmd(['follow', '--id', String(args.artist_id)]);
    }

    case 'unfollow_artist': {
      if (!args.artist_id) throw new Error('artist_id is required');
      return runSpotifyCmd(['unfollow', '--id', String(args.artist_id)]);
    }

    default:
      throw new Error(`Unknown spotify tool: ${tool}`);
  }
}

export function processSpotifyIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'spotify', 'requests');
  const responsesDir = path.join(groupIpcDir, 'spotify', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: SpotifyRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse spotify IPC request');
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
          'Spotify IPC error',
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
