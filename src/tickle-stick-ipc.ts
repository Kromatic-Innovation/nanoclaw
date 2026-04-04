/**
 * Host-side Tickle Stick IPC handler.
 *
 * Watches for request files from containers in {group}/tickle-stick/requests/,
 * reads/writes tickle-stick.yaml pipeline definitions, and writes responses to
 * {group}/tickle-stick/responses/.
 *
 * Allows agents to list, read, create, update, and delete pipeline definitions.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const TICKLE_STICK_PATH = path.join(PROJECT_ROOT, 'tickle-stick.yaml');

interface TickleStickRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface TickleStickConfig {
  tickleStick?: {
    budget?: Record<string, unknown>;
    telemetry?: Record<string, unknown>;
    pipelines?: Record<string, unknown>;
  };
  triageProvider?: Record<string, unknown>;
}

function readConfig(): TickleStickConfig {
  if (!fs.existsSync(TICKLE_STICK_PATH)) {
    return { tickleStick: { pipelines: {} } };
  }
  const raw = fs.readFileSync(TICKLE_STICK_PATH, 'utf-8');
  return (
    (yaml.parse(raw) as TickleStickConfig) || {
      tickleStick: { pipelines: {} },
    }
  );
}

function writeConfig(config: TickleStickConfig): void {
  const tempPath = `${TICKLE_STICK_PATH}.tmp`;
  fs.writeFileSync(
    tempPath,
    yaml.stringify(config, { indent: 2, lineWidth: 120 }),
  );
  fs.renameSync(tempPath, TICKLE_STICK_PATH);
}

async function handleRequest(req: TickleStickRequest): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'list_pipelines': {
      const config = readConfig();
      const pipelines = config.tickleStick?.pipelines || {};
      return Object.entries(pipelines).map(([name, def]) => ({
        name,
        stages: Array.isArray((def as { stages?: unknown[] }).stages)
          ? (def as { stages: { name?: string; type?: string }[] }).stages.map(
              (s) => ({
                name: s.name,
                type: s.type,
              }),
            )
          : [],
      }));
    }

    case 'get_pipeline': {
      if (!args.name) throw new Error('name is required');
      const config = readConfig();
      const pipelines = config.tickleStick?.pipelines || {};
      const pipeline = pipelines[args.name as string];
      if (!pipeline) throw new Error(`Pipeline "${args.name}" not found`);
      return { name: args.name, ...(pipeline as object) };
    }

    case 'create_pipeline': {
      if (!args.name) throw new Error('name is required');
      if (!args.definition) throw new Error('definition is required');
      const name = args.name as string;
      const config = readConfig();
      if (!config.tickleStick) config.tickleStick = {};
      if (!config.tickleStick.pipelines) config.tickleStick.pipelines = {};
      if (config.tickleStick.pipelines[name]) {
        throw new Error(
          `Pipeline "${name}" already exists — use update_pipeline to modify`,
        );
      }
      config.tickleStick.pipelines[name] = args.definition;
      writeConfig(config);
      return { created: name };
    }

    case 'update_pipeline': {
      if (!args.name) throw new Error('name is required');
      if (!args.definition) throw new Error('definition is required');
      const name = args.name as string;
      const config = readConfig();
      if (!config.tickleStick?.pipelines?.[name]) {
        throw new Error(`Pipeline "${name}" not found`);
      }
      config.tickleStick.pipelines[name] = args.definition;
      writeConfig(config);
      return { updated: name };
    }

    case 'delete_pipeline': {
      if (!args.name) throw new Error('name is required');
      const name = args.name as string;
      const config = readConfig();
      if (!config.tickleStick?.pipelines?.[name]) {
        throw new Error(`Pipeline "${name}" not found`);
      }
      delete config.tickleStick.pipelines[name];
      writeConfig(config);
      return { deleted: name };
    }

    case 'get_budget': {
      const config = readConfig();
      return config.tickleStick?.budget || {};
    }

    default:
      throw new Error(`Unknown tickle-stick tool: ${tool}`);
  }
}

/**
 * Process all pending Tickle Stick IPC requests in a given group's IPC directory.
 */
export function processTickleStickIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'tickle-stick', 'requests');
  const responsesDir = path.join(groupIpcDir, 'tickle-stick', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: TickleStickRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse tickle-stick IPC request');
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
          'Tickle-stick IPC error',
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
