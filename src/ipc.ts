import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { processCalendarIpc } from './calendar-ipc.js';
import { processContactsIpc } from './contacts-ipc.js';
import { processGithubIssuesIpc } from './github-issues-ipc.js';
import { processGmailIpc } from './gmail-ipc.js';
import { processMapsIpc } from './maps-ipc.js';
import { processRemindersIpc } from './reminders-ipc.js';
import { processSentryIpc } from './sentry-ipc.js';
import { processSheetsIpc } from './sheets-ipc.js';
import { processSpotifyIpc } from './spotify-ipc.js';
import { processMemoryIpc } from './memory-ipc.js';
import { RegisteredGroup } from './types.js';

/**
 * Convert an MCP tool name to a human-readable status label.
 * e.g. "mcp__google-calendar__list_events" → "Checking calendar…"
 */
function formatToolLabel(toolName: string): string {
  // Strip MCP prefix (mcp__server__tool → tool)
  const parts = toolName.split('__');
  const server = parts.length >= 2 ? parts[parts.length - 2] : '';
  const tool = parts.length >= 2 ? parts[parts.length - 1] : toolName;

  const labels: Record<string, string> = {
    'google-calendar': 'Checking calendar',
    gmail: 'Checking email',
    'google-maps': 'Looking up directions',
    sentry: 'Checking Sentry',
    spotify: 'Checking Spotify',
    'apple-reminders': 'Checking reminders',
    'github-issues': 'Checking GitHub',
    'google-sheets': 'Updating triage rules',
    'google-contacts': 'Checking contacts',
    memory: 'Saving to memory',
  };

  const serverLabel = labels[server];
  if (serverLabel) return `${serverLabel}…`;

  // Fallback: humanize the tool name
  const humanized = (tool || toolName)
    .replace(/_/g, ' ')
    .replace(/^(mcp|list|get|search|create|update|send|draft)/, (m) => m);
  return `Using ${humanized}…`;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  reloadConfig: () => void;
  restartService: (reason: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process Apple Reminders IPC requests (request-response bridge)
      try {
        processRemindersIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing reminders IPC');
      }

      // Process GitHub Issues IPC requests (request-response bridge)
      try {
        processGithubIssuesIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error processing github-issues IPC',
        );
      }

      // Process Google Calendar IPC requests (request-response bridge)
      try {
        processCalendarIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing calendar IPC');
      }

      // Process Gmail IPC requests (request-response bridge)
      try {
        processGmailIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing gmail IPC');
      }

      // Process Sentry IPC requests (request-response bridge)
      try {
        processSentryIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing sentry IPC');
      }

      // Process Google Maps IPC requests (request-response bridge)
      try {
        processMapsIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing maps IPC');
      }

      // Process Spotify IPC requests (request-response bridge)
      try {
        processSpotifyIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing spotify IPC');
      }

      // Process Google Sheets IPC requests (request-response bridge)
      try {
        processSheetsIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing sheets IPC');
      }

      // Process Google Contacts IPC requests (request-response bridge)
      try {
        processContactsIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing contacts IPC');
      }

      // Process Memory IPC requests (request-response bridge)
      try {
        processMemoryIpc(path.join(ipcBaseDir, sourceGroup));
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error processing memory IPC');
      }

      // Process system commands (reload_config, restart_service) — main group only
      try {
        const systemDir = path.join(ipcBaseDir, sourceGroup, 'system');
        if (isMain && fs.existsSync(systemDir)) {
          const systemFiles = fs
            .readdirSync(systemDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of systemFiles) {
            const filePath = path.join(systemDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              if (data.type === 'reload_config') {
                logger.info({ sourceGroup }, 'Config reload requested via IPC');
                deps.reloadConfig();
              } else if (data.type === 'restart_service') {
                logger.info(
                  { sourceGroup, reason: data.reason },
                  'Service restart requested via IPC',
                );
                deps.restartService(data.reason || 'Requested by agent');
              } else if (data.type === 'create_routine') {
                logger.info(
                  { sourceGroup, pipeline: data.pipelineName },
                  'Create routine requested via IPC',
                );
                handleCreateRoutine(data, deps);
              } else {
                logger.warn({ type: data.type }, 'Unknown system IPC command');
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing system IPC command',
              );
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading system IPC directory',
        );
      }

      // Process status updates from container (tool call notifications)
      try {
        const statusDir = path.join(ipcBaseDir, sourceGroup, 'status');
        if (fs.existsSync(statusDir)) {
          const statusFiles = fs
            .readdirSync(statusDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of statusFiles) {
            const filePath = path.join(statusDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              if (data.tool) {
                // Find the chatJid for this group folder
                const chatJid = Object.entries(registeredGroups).find(
                  ([, g]) => g.folder === sourceGroup,
                )?.[0];
                if (chatJid) {
                  const label = formatToolLabel(data.tool);
                  deps.sendMessage(chatJid, `_${label}_`).catch(() => {});
                }
              }
            } catch (err) {
              logger.debug({ file, err }, 'Error processing status file');
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        // Best-effort — status updates are non-critical
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Handle create_routine IPC command: write pipeline definition and prompts,
 * then reload configuration.
 */
function handleCreateRoutine(
  data: {
    pipelineName: string;
    stagesYaml: string;
    prompts: Record<string, string>;
    schedule: { enabled: boolean; cron: string; config_key: string } | null;
  },
  deps: IpcDeps,
): void {
  const { pipelineName, stagesYaml, prompts, schedule } = data;

  if (!pipelineName || !stagesYaml) {
    logger.warn('create_routine: missing pipelineName or stagesYaml');
    return;
  }

  // Validate pipeline name (kebab-case, no path traversal)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pipelineName)) {
    logger.warn(
      { pipelineName },
      'create_routine: invalid pipeline name (must be kebab-case)',
    );
    return;
  }

  try {
    // 1. Write prompt files to config/prompts/
    const promptsDir = path.join(process.cwd(), 'config', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });

    for (const [filename, content] of Object.entries(prompts)) {
      // Security: prevent path traversal in filenames
      const safeName = path.basename(filename);
      if (safeName !== filename || filename.includes('..')) {
        logger.warn(
          { filename },
          'create_routine: skipping unsafe prompt filename',
        );
        continue;
      }
      const promptPath = path.join(promptsDir, safeName);
      fs.writeFileSync(promptPath, content);
      logger.info({ file: safeName }, 'Wrote prompt file');
    }

    // 2. Parse the stages YAML and append pipeline to tickle-stick.yaml
    const tickleStickPath = path.join(process.cwd(), 'tickle-stick.yaml');
    if (!fs.existsSync(tickleStickPath)) {
      logger.error('create_routine: tickle-stick.yaml not found');
      return;
    }

    const yamlContent = fs.readFileSync(tickleStickPath, 'utf-8');

    // Parse the stages YAML to validate it
    let stages: unknown;
    try {
      stages = parseYaml(stagesYaml);
    } catch (err) {
      logger.error({ err }, 'create_routine: invalid stages YAML');
      return;
    }

    // Parse the full config, add the new pipeline, rewrite
    const config = parseYaml(yamlContent) as {
      tickleStick: { pipelines: Record<string, unknown> };
      [key: string]: unknown;
    };

    if (config.tickleStick?.pipelines?.[pipelineName]) {
      logger.warn(
        { pipelineName },
        'create_routine: pipeline already exists, overwriting',
      );
    }

    config.tickleStick.pipelines[pipelineName] = { stages };

    // Write back with comment preservation (stringify + prepend comment)
    const newYaml = stringifyYaml(config, {
      lineWidth: 0, // Don't wrap lines
    });
    fs.writeFileSync(tickleStickPath, newYaml);
    logger.info({ pipelineName }, 'Pipeline added to tickle-stick.yaml');

    // 3. Optionally add schedule to config/private.yaml
    if (schedule) {
      const privatePath = path.join(process.cwd(), 'config', 'private.yaml');
      if (fs.existsSync(privatePath)) {
        const privateContent = fs.readFileSync(privatePath, 'utf-8');
        const privateConfig = parseYaml(privateContent) as Record<
          string,
          unknown
        >;

        privateConfig[schedule.config_key] = {
          enabled: schedule.enabled,
          cron: schedule.cron,
        };

        const newPrivateYaml = stringifyYaml(privateConfig, {
          lineWidth: 0,
        });
        fs.writeFileSync(privatePath, newPrivateYaml);
        logger.info(
          { key: schedule.config_key, cron: schedule.cron },
          'Schedule added to config/private.yaml',
        );
      }
    }

    // 4. Reload config to pick up the new pipeline
    deps.reloadConfig();
  } catch (err) {
    logger.error({ err, pipelineName }, 'Failed to create routine');
  }
}
