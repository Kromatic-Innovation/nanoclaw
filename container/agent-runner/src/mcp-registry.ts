/**
 * MCP server registry.
 *
 * Central manifest of all MCP servers available to the container agent.
 * Adding a new integration requires one entry here (plus the *-mcp-stdio.ts file).
 *
 * The 'nanoclaw' core server is NOT in this registry — it's always present
 * and configured separately with container-specific env vars.
 *
 * Ref: Kromatic-Innovation/nanoclaw#30
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface McpServerEntry {
  /** MCP server name (used in mcpServers config key) */
  name: string;
  /** Compiled JS filename in the same directory */
  scriptFile: string;
  /** Glob pattern for allowedTools (e.g. 'mcp__google-calendar__*') */
  allowedToolPattern: string;
  /**
   * Optional env factory. Receives containerInput and returns extra env vars.
   * If omitted, the server gets an empty env object.
   */
  env?: (containerInput: { groupFolder: string; isMain: boolean }) => Record<string, string>;
}

/**
 * All registered MCP servers. To add a new integration:
 * 1. Create {service}-mcp-stdio.ts
 * 2. Add an entry here
 * 3. Create src/{service}-ipc.ts on the host side
 * 4. Add an entry to src/ipc-registry.ts
 */
export const mcpServers: McpServerEntry[] = [
  {
    name: 'google-drive',
    scriptFile: 'drive-mcp-stdio.js',
    allowedToolPattern: 'mcp__google-drive__*',
  },
  {
    name: 'google-gmail',
    scriptFile: 'gmail-mcp-stdio.js',
    allowedToolPattern: 'mcp__google-gmail__*',
  },
  {
    name: 'google-docs',
    scriptFile: 'docs-mcp-stdio.js',
    allowedToolPattern: 'mcp__google-docs__*',
  },
  {
    name: 'google-sheets',
    scriptFile: 'sheets-mcp-stdio.js',
    allowedToolPattern: 'mcp__google-sheets__*',
  },
  {
    name: 'google-calendar',
    scriptFile: 'calendar-mcp-stdio.js',
    allowedToolPattern: 'mcp__google-calendar__*',
  },
];

/** Resolve the full path to a server's compiled JS file */
export function resolveServerPath(entry: McpServerEntry): string {
  return path.join(__dirname, entry.scriptFile);
}
