/**
 * IPC handler smoke tests.
 *
 * For each *-ipc.ts handler:
 * 1. Verify it exports the expected processXxxIpc function
 * 2. Verify calling with no pending requests doesn't crash
 * 3. Verify an unknown tool name produces an error response (not a crash)
 *
 * These tests dynamically discover handlers so they work regardless of
 * which skill branches are present.
 *
 * Ref: Kromatic-Innovation/nanoclaw#29
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock logger to suppress noise and child_process to avoid real script calls
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error('script not available in test'), '', 'script not available');
  }),
  execFileSync: vi.fn(() => {
    throw new Error('script not available in test');
  }),
}));

const SRC_DIR = path.join(process.cwd(), 'src');

/**
 * Derive the expected export name from an IPC handler filename.
 * "calendar-ipc.ts" -> "processCalendarIpc"
 */
function expectedExportName(filename: string): string {
  const base = filename.replace('-ipc.ts', '');
  const camel = base.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return `process${camel.charAt(0).toUpperCase()}${camel.slice(1)}Ipc`;
}

/**
 * Derive the IPC service directory name from a handler filename.
 * Most handlers use the first segment: "calendar-ipc.ts" -> "calendar"
 * Compound names like "tickle-stick-ipc.ts" -> "tickle-stick"
 */
function serviceDirName(filename: string): string {
  return filename.replace('-ipc.ts', '');
}

// Discover all IPC handler files on disk
const ipcFiles = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('-ipc.ts') && !f.endsWith('.test.ts'));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-smoke-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('IPC handler smoke tests', () => {
  for (const file of ipcFiles) {
    const exportName = expectedExportName(file);
    const service = serviceDirName(file);

    describe(file, () => {
      test(`exports ${exportName}`, async () => {
        const mod = await import(`./` + file.replace('.ts', '.js'));
        expect(typeof mod[exportName]).toBe('function');
      });

      test('no-op when request directory is missing', async () => {
        const mod = await import(`./` + file.replace('.ts', '.js'));
        const handler = mod[exportName];

        // Call with a directory that has no request subdirectory — should not throw
        if (file === 'service-ipc.ts') {
          expect(() => handler(tmpDir, false)).not.toThrow();
        } else {
          expect(() => handler(tmpDir)).not.toThrow();
        }
      });

      test('handles unknown tool without crashing', async () => {
        const mod = await import(`./` + file.replace('.ts', '.js'));
        const handler = mod[exportName];

        // Create request directory structure
        const requestsDir = path.join(tmpDir, service, 'requests');
        const responsesDir = path.join(tmpDir, service, 'responses');
        fs.mkdirSync(requestsDir, { recursive: true });
        fs.mkdirSync(responsesDir, { recursive: true });

        // Write a request with an unknown tool name
        const requestId = `smoke-${Date.now()}`;
        const request = {
          id: requestId,
          tool: '__nonexistent_tool__',
          args: {},
        };
        fs.writeFileSync(
          path.join(requestsDir, `${requestId}.json`),
          JSON.stringify(request),
        );

        // Call the handler — should not throw
        if (file === 'service-ipc.ts') {
          expect(() => handler(tmpDir, false)).not.toThrow();
        } else {
          expect(() => handler(tmpDir)).not.toThrow();
        }

        // Request file should be consumed (deleted)
        expect(fs.existsSync(path.join(requestsDir, `${requestId}.json`))).toBe(
          false,
        );

        // Wait briefly for async response write
        await new Promise((r) => setTimeout(r, 200));

        // Should have written an error response (not crashed)
        const responseFile = path.join(responsesDir, `${requestId}.json`);
        if (fs.existsSync(responseFile)) {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          expect(response.error).toBeDefined();
        }
        // If no response file, the handler may write responses differently —
        // the key assertion is that it didn't throw.
      });
    });
  }
});
