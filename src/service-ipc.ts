/**
 * Host-side Service IPC handler.
 *
 * Watches for request files from containers in {group}/service/requests/,
 * executes service management commands (restart, reload, status),
 * and writes responses to {group}/service/responses/.
 *
 * Only the main group is authorized to restart/reload the service.
 * Any group can check service status.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const SERVICE_START_TIME = new Date().toISOString();

interface ServiceRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Detect the platform and return the appropriate restart command.
 * macOS uses launchctl, Linux uses systemctl.
 */
function getRestartCommand(): { cmd: string; args: string[] } {
  if (os.platform() === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    return {
      cmd: 'launchctl',
      args: ['kickstart', '-k', `gui/${uid}/com.nanoclaw`],
    };
  }
  return {
    cmd: 'systemctl',
    args: ['--user', 'restart', 'nanoclaw'],
  };
}

/**
 * Detect the platform and return the appropriate status command.
 */
function getStatusCommand(): { cmd: string; args: string[] } {
  if (os.platform() === 'darwin') {
    const uid = process.getuid?.() ?? 501;
    return {
      cmd: 'launchctl',
      args: ['print', `gui/${uid}/com.nanoclaw`],
    };
  }
  return {
    cmd: 'systemctl',
    args: ['--user', 'status', 'nanoclaw'],
  };
}

/**
 * Read the current version from package.json.
 */
function getVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // For status commands, non-zero exit is informational, not an error
          if (cmd === 'launchctl' || cmd === 'systemctl') {
            resolve({ stdout: stdout || '', stderr: stderr || error.message });
            return;
          }
          reject(
            new Error(
              `Command failed: ${cmd} ${args.join(' ')}: ${stderr || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

async function handleRequest(
  req: ServiceRequest,
  isMain: boolean,
): Promise<unknown> {
  const { tool, args } = req;

  switch (tool) {
    case 'restart_service': {
      if (!isMain) {
        throw new Error('Only the main group can restart the service');
      }
      const reason = String(args.reason || 'No reason provided');
      logger.info({ reason }, 'Service restart requested via IPC');

      const { cmd, args: cmdArgs } = getRestartCommand();

      // Schedule the restart with a short delay so the response can be written
      // back to the container before the process exits.
      const restartPromise = new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          execFile(
            cmd,
            cmdArgs,
            { timeout: 15000 },
            (error, _stdout, stderr) => {
              if (error) {
                reject(new Error(`Restart failed: ${stderr || error.message}`));
                return;
              }
              resolve('Restart initiated');
            },
          );
        }, 1000);
      });

      // Return immediately — the restart happens asynchronously
      // The delay gives time for the response to be written
      restartPromise.catch((err) => {
        logger.error({ err, reason }, 'Service restart failed');
      });

      return {
        status: 'restart_scheduled',
        reason,
        platform: os.platform(),
        message:
          'Service restart has been scheduled. The service will restart in ~1 second.',
      };
    }

    case 'reload_config': {
      if (!isMain) {
        throw new Error('Only the main group can reload config');
      }
      const reason = String(args.reason || 'No reason provided');
      logger.info({ reason }, 'Config reload requested via IPC');

      // Send SIGHUP to self to trigger config reload
      process.kill(process.pid, 'SIGHUP');

      return {
        status: 'reload_sent',
        reason,
        message: 'SIGHUP sent to service process. Config will be reloaded.',
      };
    }

    case 'get_service_status': {
      const version = getVersion();
      const uptime = Date.now() - new Date(SERVICE_START_TIME).getTime();
      const uptimeSeconds = Math.floor(uptime / 1000);
      const uptimeMinutes = Math.floor(uptimeSeconds / 60);
      const uptimeHours = Math.floor(uptimeMinutes / 60);

      let serviceStatus = 'unknown';
      try {
        const { cmd, args: cmdArgs } = getStatusCommand();
        const { stdout } = await runCommand(cmd, cmdArgs);
        serviceStatus = stdout.trim() || 'running (no output)';
      } catch (err) {
        serviceStatus = `error: ${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        version,
        platform: os.platform(),
        pid: process.pid,
        started_at: SERVICE_START_TIME,
        uptime: {
          hours: uptimeHours,
          minutes: uptimeMinutes % 60,
          seconds: uptimeSeconds % 60,
          total_ms: uptime,
        },
        service_manager_status: serviceStatus,
      };
    }

    default:
      throw new Error(`Unknown service tool: ${tool}`);
  }
}

/**
 * Process all pending Service IPC requests in a given group's IPC directory.
 */
export function processServiceIpc(groupIpcDir: string, isMain: boolean): void {
  const requestsDir = path.join(groupIpcDir, 'service', 'requests');
  const responsesDir = path.join(groupIpcDir, 'service', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: ServiceRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse service IPC request');
      fs.unlinkSync(requestPath);
      continue;
    }

    // Delete the request file immediately to avoid reprocessing
    fs.unlinkSync(requestPath);

    // Process async — write response when done
    handleRequest(req, isMain)
      .then((result) => {
        writeResponse(responsesDir, req.id, { result });
      })
      .catch((err) => {
        logger.error(
          { requestId: req.id, tool: req.tool, err },
          'Service IPC error',
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
