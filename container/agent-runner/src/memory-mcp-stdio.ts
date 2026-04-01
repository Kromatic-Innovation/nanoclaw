/**
 * Memory MCP Server (container-side)
 *
 * Runs inside the container. Exposes memory tools to the agent.
 *
 * Group-scoped operations use direct filesystem access (no IPC needed).
 * Global-scoped operations use the IPC bridge to the host.
 *
 * Group memory: /workspace/group/memory/*.md
 * Global memory: via IPC to /workspace/ipc/memory/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const REQUESTS_DIR = path.join(IPC_DIR, 'memory', 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'memory', 'responses');
const GROUP_MEMORY_DIR = '/workspace/group/memory';

const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 30_000;
const MAX_SEARCH_RESULTS = 50;

const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || 'unknown';
const IS_MAIN = process.env.NANOCLAW_IS_MAIN === '1';

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- IPC helpers (for global scope) ---

async function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const requestId = generateId();
  const requestFile = path.join(REQUESTS_DIR, `${requestId}.json`);
  const responseFile = path.join(RESPONSES_DIR, `${requestId}.json`);

  fs.mkdirSync(REQUESTS_DIR, { recursive: true });

  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(
    tempFile,
    JSON.stringify({
      id: requestId,
      tool,
      args: { ...args, source_group: GROUP_FOLDER, is_main: IS_MAIN },
    }),
  );
  fs.renameSync(tempFile, requestFile);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const raw = fs.readFileSync(responseFile, 'utf-8');
      fs.unlinkSync(responseFile);
      const response = JSON.parse(raw);
      if (response.error) {
        throw new Error(response.error);
      }
      return response.result;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Memory IPC timeout after ${TIMEOUT_MS}ms for tool "${tool}"`,
  );
}

// --- Local filesystem helpers (for group scope) ---

interface MemoryFile {
  id: string;
  type: string;
  scope: string;
  tags: string[];
  created: string;
  source_group: string;
  content: string;
}

function parseFrontmatter(raw: string): MemoryFile | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  let tags: string[] = [];
  if (meta.tags) {
    const tagMatch = meta.tags.match(/\[(.*)\]/);
    if (tagMatch) {
      tags = tagMatch[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }

  return {
    id: meta.id || '',
    type: meta.type || '',
    scope: meta.scope || 'group',
    tags,
    created: meta.created || '',
    source_group: meta.source_group || '',
    content: match[2].trim(),
  };
}

function buildMemoryFile(
  id: string,
  type: string,
  scope: string,
  tags: string[],
  content: string,
): string {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `scope: ${scope}`,
    `tags: [${tags.join(', ')}]`,
    `created: ${new Date().toISOString()}`,
    `source_group: ${GROUP_FOLDER}`,
    '---',
    '',
    content,
    '',
  ].join('\n');
}

function readAllGroupMemories(): MemoryFile[] {
  if (!fs.existsSync(GROUP_MEMORY_DIR)) return [];

  const files = fs
    .readdirSync(GROUP_MEMORY_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

  const memories: MemoryFile[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(GROUP_MEMORY_DIR, file), 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (parsed) memories.push(parsed);
    } catch {
      // Skip unparseable files
    }
  }

  return memories;
}

function searchMemories(
  memories: MemoryFile[],
  query: string,
  tag?: string,
  type?: string,
): MemoryFile[] {
  const q = query.toLowerCase();
  return memories
    .filter((m) => {
      if (tag && !m.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
        return false;
      if (type && m.type !== type) return false;
      if (!query) return true;
      return (
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)) ||
        m.type.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, MAX_SEARCH_RESULTS);
}

function memoryToSummary(m: MemoryFile) {
  return {
    id: m.id,
    type: m.type,
    scope: m.scope,
    tags: m.tags,
    created: m.created,
    source_group: m.source_group,
    preview: m.content.slice(0, 200),
  };
}

function regenerateGroupIndex(): void {
  const memories = readAllGroupMemories();
  const lines = [
    '# Group Memory Index',
    `Updated: ${new Date().toISOString()}`,
    '',
  ];

  if (memories.length === 0) {
    lines.push('No memories saved yet.');
  } else {
    lines.push('| ID | Type | Tags | Created | Preview |');
    lines.push('|----|------|------|---------|---------|');
    for (const m of memories) {
      const preview = m.content
        .slice(0, 60)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      const date = m.created.split('T')[0] || '';
      lines.push(
        `| ${m.id} | ${m.type} | ${m.tags.join(', ')} | ${date} | ${preview} |`,
      );
    }
  }

  fs.mkdirSync(GROUP_MEMORY_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(GROUP_MEMORY_DIR, 'MEMORY.md'),
    lines.join('\n') + '\n',
  );
}

// --- MCP tool result helper ---

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'memory',
  version: '1.0.0',
});

server.tool(
  'save_memory',
  'Save a memory that persists across sessions. Use "group" scope for info specific to this conversation, "global" scope for info any conversation should know.',
  {
    content: z.string().describe('The memory content to save'),
    scope: z
      .enum(['global', 'group'])
      .describe(
        'global = shared across all groups, group = private to this conversation',
      ),
    type: z
      .enum(['preference', 'correction', 'fact', 'pattern'])
      .describe(
        'preference = user preference, correction = learned from a mistake, fact = factual information, pattern = observed behavior pattern',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional tags for categorization and search'),
  },
  async (args) => {
    const tags = args.tags || [];

    if (args.scope === 'group') {
      const id = generateId();
      const fileContent = buildMemoryFile(
        id,
        args.type,
        'group',
        tags,
        args.content,
      );
      fs.mkdirSync(GROUP_MEMORY_DIR, { recursive: true });
      const filePath = path.join(GROUP_MEMORY_DIR, `${id}.md`);
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, fileContent);
      fs.renameSync(tempPath, filePath);
      regenerateGroupIndex();
      return textResult({ saved: true, id, scope: 'group' });
    }

    // Global scope — use IPC
    return textResult(
      await ipcRequest('save_memory', {
        content: args.content,
        type: args.type,
        tags,
      }),
    );
  },
);

server.tool(
  'search_memory',
  'Search saved memories by keyword. Returns matching memories sorted by recency.',
  {
    query: z
      .string()
      .describe('Search text (case-insensitive substring match)'),
    scope: z
      .enum(['global', 'group', 'all'])
      .default('all')
      .describe('Which memories to search: global, group, or all'),
  },
  async (args) => {
    const results: Array<ReturnType<typeof memoryToSummary>> = [];

    if (args.scope === 'group' || args.scope === 'all') {
      const groupMemories = readAllGroupMemories();
      const matches = searchMemories(groupMemories, args.query);
      results.push(...matches.map(memoryToSummary));
    }

    if (args.scope === 'global' || args.scope === 'all') {
      const globalResults = (await ipcRequest('search_memory', {
        query: args.query,
      })) as Array<ReturnType<typeof memoryToSummary>>;
      results.push(...globalResults);
    }

    // Sort merged results by created date descending
    results.sort((a, b) => b.created.localeCompare(a.created));
    return textResult({
      count: results.length,
      memories: results.slice(0, MAX_SEARCH_RESULTS),
    });
  },
);

server.tool(
  'list_memories',
  'List all saved memories, optionally filtered by tag or type.',
  {
    scope: z
      .enum(['global', 'group', 'all'])
      .default('all')
      .describe('Which memories to list'),
    tag: z.string().optional().describe('Filter by tag'),
    type: z
      .enum(['preference', 'correction', 'fact', 'pattern'])
      .optional()
      .describe('Filter by memory type'),
  },
  async (args) => {
    const results: Array<ReturnType<typeof memoryToSummary>> = [];

    if (args.scope === 'group' || args.scope === 'all') {
      const groupMemories = readAllGroupMemories();
      const filtered = searchMemories(groupMemories, '', args.tag, args.type);
      results.push(...filtered.map(memoryToSummary));
    }

    if (args.scope === 'global' || args.scope === 'all') {
      const globalResults = (await ipcRequest('list_memories', {
        tag: args.tag,
        type: args.type,
      })) as Array<ReturnType<typeof memoryToSummary>>;
      results.push(...globalResults);
    }

    results.sort((a, b) => b.created.localeCompare(a.created));
    return textResult({
      count: results.length,
      memories: results.slice(0, MAX_SEARCH_RESULTS),
    });
  },
);

server.tool(
  'delete_memory',
  'Delete a memory by its ID.',
  {
    id: z.string().describe('The memory ID to delete'),
    scope: z
      .enum(['global', 'group'])
      .describe('The scope of the memory to delete'),
  },
  async (args) => {
    if (args.scope === 'group') {
      const filePath = path.join(GROUP_MEMORY_DIR, `${args.id}.md`);
      if (!fs.existsSync(filePath)) {
        return textResult({ deleted: false, error: 'Memory not found' });
      }
      fs.unlinkSync(filePath);
      regenerateGroupIndex();
      return textResult({ deleted: true, id: args.id, scope: 'group' });
    }

    // Global scope — use IPC
    return textResult(await ipcRequest('delete_memory', { id: args.id }));
  },
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
