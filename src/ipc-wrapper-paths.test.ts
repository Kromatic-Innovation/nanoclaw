/**
 * IPC handler wrapper-path smoke tests.
 *
 * Regression guard for nanoclaw#34: IPC handlers previously hardcoded
 * ~/.openclaw/workspace/scripts/ instead of using process.cwd() + '/scripts/'.
 *
 * These tests verify:
 * 1. Every *-ipc.ts file resolves SCRIPTS_DIR via process.cwd() (no hardcoded home paths)
 * 2. Every referenced Python wrapper script actually exists on disk
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const SRC_DIR = path.join(process.cwd(), 'src');
const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');

/**
 * Map of IPC handler -> wrapper scripts it references.
 * Derived from grepping SCRIPTS_DIR / *_WRAPPER / *_SCRIPT constants.
 */
const IPC_WRAPPER_MAP: Record<string, string[]> = {
  'drive-ipc.ts': ['google_drive_wrapper.py'],
  'gmail-ipc.ts': ['gmail_wrapper.py', 'email-action-guard.py'],
  'calendar-ipc.ts': ['google_calendar_wrapper.py'],
  'docs-ipc.ts': ['google_docs_wrapper.py'],
  'sheets-ipc.ts': ['sheets_contact_db.py', 'google_sheets_wrapper.py'],
  'contacts-ipc.ts': ['google_contacts_wrapper.py'],
  'maps-ipc.ts': ['google_maps_wrapper.py'],
  'sentry-ipc.ts': ['sentry_wrapper.py'],
  'spotify-ipc.ts': ['spotify_wrapper.py'],
};

describe('IPC wrapper script paths', () => {
  describe('wrapper scripts exist on disk', () => {
    for (const [ipcFile, wrappers] of Object.entries(IPC_WRAPPER_MAP)) {
      for (const wrapper of wrappers) {
        test(`${ipcFile} -> scripts/${wrapper} exists`, () => {
          const fullPath = path.join(SCRIPTS_DIR, wrapper);
          expect(
            fs.existsSync(fullPath),
            `${fullPath} referenced by ${ipcFile} does not exist`,
          ).toBe(true);
        });
      }
    }
  });

  describe('no hardcoded home paths in IPC handlers', () => {
    const ipcFiles = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith('-ipc.ts'));

    for (const file of ipcFiles) {
      test(`${file} does not contain hardcoded home paths`, () => {
        const content = fs.readFileSync(path.join(SRC_DIR, file), 'utf-8');
        expect(content).not.toMatch(/\.openclaw/);
        expect(content).not.toMatch(/\/home\//);
        expect(content).not.toMatch(/\/Users\//);
      });
    }
  });

  describe('IPC handlers use process.cwd() for SCRIPTS_DIR', () => {
    const ipcFiles = fs
      .readdirSync(SRC_DIR)
      .filter((f) => f.endsWith('-ipc.ts'));

    for (const file of ipcFiles) {
      const content = fs.readFileSync(path.join(SRC_DIR, file), 'utf-8');
      // Only test files that define SCRIPTS_DIR
      if (!content.includes('SCRIPTS_DIR')) continue;

      test(`${file} defines SCRIPTS_DIR using process.cwd()`, () => {
        const scriptsDirLine = content
          .split('\n')
          .find((line) => line.includes('SCRIPTS_DIR') && line.includes('='));
        expect(scriptsDirLine).toBeDefined();
        expect(scriptsDirLine).toContain('process.cwd()');
      });
    }
  });
});
