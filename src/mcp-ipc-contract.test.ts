/**
 * MCP-to-IPC contract validation.
 *
 * Ensures every MCP tool registered in container/agent-runner/src/*-mcp-stdio.ts
 * has a corresponding `case 'tool_name':` in the matching src/*-ipc.ts handler.
 *
 * This catches schema drift — e.g. adding a new MCP tool but forgetting the
 * host-side IPC handler case (exactly what caused nanoclaw#26).
 *
 * Dynamically discovers files so the test works across skill branches.
 *
 * Ref: Kromatic-Innovation/nanoclaw#29
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const SRC_DIR = path.join(process.cwd(), 'src');
const MCP_DIR = path.join(process.cwd(), 'container', 'agent-runner', 'src');

/**
 * Extract tool names from an MCP stdio server file.
 * Matches patterns like: server.tool('tool_name', or server.tool("tool_name",
 */
function extractMcpToolNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const toolPattern = /server\.tool\(\s*['"]([^'"]+)['"]/g;
  const tools: string[] = [];
  let match;
  while ((match = toolPattern.exec(content)) !== null) {
    tools.push(match[1]);
  }
  return tools;
}

/**
 * Extract case labels from an IPC handler file.
 * Matches patterns like: case 'tool_name': or case "tool_name":
 */
function extractIpcCaseNames(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const casePattern = /case\s+['"]([^'"]+)['"]\s*:/g;
  const cases: string[] = [];
  let match;
  while ((match = casePattern.exec(content)) !== null) {
    cases.push(match[1]);
  }
  return cases;
}

/**
 * Map MCP server files to their IPC handler counterparts.
 * "calendar-mcp-stdio.ts" -> "calendar-ipc.ts"
 */
function mcpToIpcFilename(mcpFile: string): string {
  return mcpFile.replace('-mcp-stdio.ts', '-ipc.ts');
}

// Skip the generic IPC MCP bridge — it doesn't map 1:1 to a handler
const SKIP_MCP_FILES = new Set(['ipc-mcp-stdio.ts']);

// Discover MCP server files
const mcpFiles = fs.existsSync(MCP_DIR)
  ? fs
      .readdirSync(MCP_DIR)
      .filter((f) => f.endsWith('-mcp-stdio.ts') && !SKIP_MCP_FILES.has(f))
  : [];

describe('MCP-to-IPC contract', () => {
  test('MCP server files exist', () => {
    expect(mcpFiles.length).toBeGreaterThan(0);
  });

  for (const mcpFile of mcpFiles) {
    const ipcFile = mcpToIpcFilename(mcpFile);
    const mcpPath = path.join(MCP_DIR, mcpFile);
    const ipcPath = path.join(SRC_DIR, ipcFile);

    describe(`${mcpFile} ↔ ${ipcFile}`, () => {
      test('IPC handler file exists', () => {
        expect(
          fs.existsSync(ipcPath),
          `Missing IPC handler ${ipcFile} for MCP server ${mcpFile}`,
        ).toBe(true);
      });

      if (fs.existsSync(ipcPath)) {
        const mcpTools = extractMcpToolNames(mcpPath);
        const ipcCases = extractIpcCaseNames(ipcPath);

        test('MCP server registers at least one tool', () => {
          expect(mcpTools.length).toBeGreaterThan(0);
        });

        for (const tool of mcpTools) {
          test(`MCP tool "${tool}" has IPC handler case`, () => {
            expect(
              ipcCases,
              `MCP tool "${tool}" in ${mcpFile} has no matching case in ${ipcFile}. ` +
                `IPC cases: [${ipcCases.join(', ')}]`,
            ).toContain(tool);
          });
        }
      }
    });
  }
});
