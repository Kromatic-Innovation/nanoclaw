import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Initialize tempDir before the mock getter is called during import
let tempDir: string = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nanoclaw-memory-test-'),
);

vi.mock('./config.js', () => ({
  get GROUPS_DIR() {
    return path.join(tempDir, 'groups');
  },
}));

// Must import after mock is set up
const { processMemoryIpc } = await import('./memory-ipc.js');

function setupDirs() {
  // Clean and recreate for each test
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-test-'));
  const globalMemDir = path.join(tempDir, 'groups', 'global', 'memory');
  fs.mkdirSync(globalMemDir, { recursive: true });
  const ipcDir = path.join(tempDir, 'ipc', 'test-group');
  fs.mkdirSync(path.join(ipcDir, 'memory', 'requests'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'memory', 'responses'), { recursive: true });
  return { globalMemDir, ipcDir };
}

function writeRequest(
  ipcDir: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(ipcDir, 'memory', 'requests', `${id}.json`);
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      id,
      tool,
      args: { ...args, source_group: 'test-group', is_main: true },
    }),
  );
  return id;
}

function waitForResponse(
  ipcDir: string,
  requestId: string,
  timeoutMs = 5000,
): Promise<{ result?: unknown; error?: string }> {
  const responseFile = path.join(
    ipcDir,
    'memory',
    'responses',
    `${requestId}.json`,
  );
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(responseFile)) {
        const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        resolve(data);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Response timeout'));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

describe('memory-ipc', () => {
  let ipcDir: string;
  let globalMemDir: string;

  beforeEach(() => {
    const dirs = setupDirs();
    ipcDir = dirs.ipcDir;
    globalMemDir = dirs.globalMemDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves a global memory and returns its ID', async () => {
    const requestId = writeRequest(ipcDir, 'save_memory', {
      content: 'The office is at 123 Main St',
      type: 'fact',
      tags: ['office', 'location'],
    });

    processMemoryIpc(ipcDir);
    const response = await waitForResponse(ipcDir, requestId);

    expect(response.result).toMatchObject({
      saved: true,
      scope: 'global',
    });
    expect((response.result as { id: string }).id).toBeTruthy();

    // Verify file was written
    const files = fs
      .readdirSync(globalMemDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    expect(files.length).toBe(1);

    // Verify MEMORY.md index was generated
    const indexPath = path.join(globalMemDir, 'MEMORY.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = fs.readFileSync(indexPath, 'utf-8');
    expect(index).toContain('123 Main St');
  });

  it('detects duplicate memories', async () => {
    // Save first memory
    const id1 = writeRequest(ipcDir, 'save_memory', {
      content: 'The office is at 123 Main St',
      type: 'fact',
      tags: [],
    });
    processMemoryIpc(ipcDir);
    await waitForResponse(ipcDir, id1);

    // Try to save a duplicate
    const id2 = writeRequest(ipcDir, 'save_memory', {
      content: 'The office is at 123 Main St',
      type: 'fact',
      tags: [],
    });
    processMemoryIpc(ipcDir);
    const response = await waitForResponse(ipcDir, id2);

    expect(response.result).toMatchObject({
      saved: false,
      duplicate: true,
    });
  });

  it('searches memories by keyword', async () => {
    // Save two memories
    const id1 = writeRequest(ipcDir, 'save_memory', {
      content: 'Alice prefers dark mode',
      type: 'preference',
      tags: ['ui'],
    });
    processMemoryIpc(ipcDir);
    await waitForResponse(ipcDir, id1);

    const id2 = writeRequest(ipcDir, 'save_memory', {
      content: 'Bob likes light mode',
      type: 'preference',
      tags: ['ui'],
    });
    processMemoryIpc(ipcDir);
    await waitForResponse(ipcDir, id2);

    // Search for Alice
    const searchId = writeRequest(ipcDir, 'search_memory', {
      query: 'alice',
    });
    processMemoryIpc(ipcDir);
    const response = await waitForResponse(ipcDir, searchId);

    const results = response.result as Array<{ preview: string }>;
    expect(results.length).toBe(1);
    expect(results[0].preview).toContain('Alice');
  });

  it('lists memories filtered by type', async () => {
    const id1 = writeRequest(ipcDir, 'save_memory', {
      content: 'Use metric units',
      type: 'preference',
      tags: [],
    });
    processMemoryIpc(ipcDir);
    await waitForResponse(ipcDir, id1);

    const id2 = writeRequest(ipcDir, 'save_memory', {
      content: 'The API endpoint changed',
      type: 'fact',
      tags: [],
    });
    processMemoryIpc(ipcDir);
    await waitForResponse(ipcDir, id2);

    // List only preferences
    const listId = writeRequest(ipcDir, 'list_memories', {
      type: 'preference',
    });
    processMemoryIpc(ipcDir);
    const response = await waitForResponse(ipcDir, listId);

    const results = response.result as Array<{ type: string }>;
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('preference');
  });

  it('deletes a memory', async () => {
    // Save a memory
    const saveId = writeRequest(ipcDir, 'save_memory', {
      content: 'Temporary fact',
      type: 'fact',
      tags: [],
    });
    processMemoryIpc(ipcDir);
    const saveResponse = await waitForResponse(ipcDir, saveId);
    const memoryId = (saveResponse.result as { id: string }).id;

    // Delete it
    const deleteId = writeRequest(ipcDir, 'delete_memory', {
      id: memoryId,
    });
    processMemoryIpc(ipcDir);
    const deleteResponse = await waitForResponse(ipcDir, deleteId);

    expect(deleteResponse.result).toMatchObject({
      deleted: true,
      id: memoryId,
    });

    // Verify file is gone
    const files = fs
      .readdirSync(globalMemDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    expect(files.length).toBe(0);
  });

  it('rejects global writes when policy is main_only and group is not main', async () => {
    // Set policy
    process.env.MEMORY_GLOBAL_WRITE_POLICY = 'main_only';

    // Write request with is_main: false (override the default)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(ipcDir, 'memory', 'requests', `${id}.json`);
    fs.writeFileSync(
      requestFile,
      JSON.stringify({
        id,
        tool: 'save_memory',
        args: {
          content: 'Should be rejected',
          type: 'fact',
          tags: [],
          source_group: 'other-group',
          is_main: false,
        },
      }),
    );

    processMemoryIpc(ipcDir);
    const response = await waitForResponse(ipcDir, id);

    expect(response.error).toContain('Global write denied');

    // Clean up
    delete process.env.MEMORY_GLOBAL_WRITE_POLICY;
  });
});
