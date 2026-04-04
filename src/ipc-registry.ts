/**
 * IPC handler registry.
 *
 * Central manifest of all IPC service handlers. Adding a new integration
 * requires one import + one array entry here (plus the handler and MCP files).
 *
 * Ref: Kromatic-Innovation/nanoclaw#30
 */

import { processCalendarIpc } from './calendar-ipc.js';
import { processDocsIpc } from './docs-ipc.js';
import { processDriveIpc } from './drive-ipc.js';
import { processGmailIpc } from './gmail-ipc.js';
import { processSheetsIpc } from './sheets-ipc.js';

export interface IpcDescriptor {
  /** IPC directory name (e.g. 'calendar' → {groupIpcDir}/calendar/requests/) */
  serviceName: string;
  /** Handler function — called with (groupIpcDir) or (groupIpcDir, isMain) */
  process: (groupIpcDir: string, ...args: unknown[]) => void;
  /** If true, handler receives isMain as second argument */
  requiresIsMain?: boolean;
}

/**
 * All registered IPC handlers. To add a new integration:
 * 1. Create {service}-ipc.ts with processXxxIpc function
 * 2. Import it here and add an entry to this array
 * 3. Create {service}-mcp-stdio.ts in container/agent-runner/src/
 * 4. Add an entry to container/agent-runner/src/mcp-registry.ts
 */
export const ipcHandlers: IpcDescriptor[] = [
  { serviceName: 'calendar', process: processCalendarIpc },
  { serviceName: 'docs', process: processDocsIpc },
  { serviceName: 'drive', process: processDriveIpc },
  { serviceName: 'gmail', process: processGmailIpc },
  { serviceName: 'sheets', process: processSheetsIpc },
];
