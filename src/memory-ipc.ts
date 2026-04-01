/**
 * Host-side Memory IPC handler.
 *
 * Watches for request files from containers in {group}/memory/requests/,
 * handles global memory operations (read/write to groups/global/memory/),
 * and writes responses to {group}/memory/responses/.
 *
 * Group-scoped memory is handled directly by the container-side MCP server
 * (no IPC needed). This handler only processes global-scoped operations.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

function getGlobalMemoryDir(): string {
  return path.join(GROUPS_DIR, 'global', 'memory');
}

interface MemoryRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

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
    scope: meta.scope || 'global',
    tags,
    created: meta.created || '',
    source_group: meta.source_group || '',
    content: match[2].trim(),
  };
}

function readAllGlobalMemories(): MemoryFile[] {
  fs.mkdirSync(getGlobalMemoryDir(), { recursive: true });

  const files = fs
    .readdirSync(getGlobalMemoryDir())
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');

  const memories: MemoryFile[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(
        path.join(getGlobalMemoryDir(), file),
        'utf-8',
      );
      const parsed = parseFrontmatter(raw);
      if (parsed) memories.push(parsed);
    } catch {
      // Skip unparseable files
    }
  }

  return memories;
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

function regenerateGlobalIndex(): void {
  const memories = readAllGlobalMemories();
  const lines = [
    '# Global Memory Index',
    `Updated: ${new Date().toISOString()}`,
    '',
  ];

  if (memories.length === 0) {
    lines.push('No global memories saved yet.');
  } else {
    lines.push('| ID | Type | Tags | Source | Created | Preview |');
    lines.push('|----|------|------|--------|---------|---------|');
    for (const m of memories) {
      const preview = m.content
        .slice(0, 60)
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      const date = m.created.split('T')[0] || '';
      lines.push(
        `| ${m.id} | ${m.type} | ${m.tags.join(', ')} | ${m.source_group} | ${date} | ${preview} |`,
      );
    }
  }

  fs.writeFileSync(
    path.join(getGlobalMemoryDir(), 'MEMORY.md'),
    lines.join('\n') + '\n',
  );
}

/**
 * Normalize whitespace for dedup comparison.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Check if a new memory is a near-duplicate of an existing one.
 * Returns the existing memory's ID if duplicate, null otherwise.
 */
function findDuplicate(content: string, memories: MemoryFile[]): string | null {
  const normalized = normalize(content);
  if (!normalized) return null;

  for (const m of memories) {
    const existing = normalize(m.content);
    if (!existing) continue;
    // Check substring in either direction
    if (normalized.includes(existing) || existing.includes(normalized)) {
      return m.id;
    }
  }

  return null;
}

/**
 * Check write policy for global memory.
 */
function canWriteGlobal(isMain: boolean): boolean {
  const policy = process.env.MEMORY_GLOBAL_WRITE_POLICY || 'any';
  if (policy === 'main_only' && !isMain) {
    return false;
  }
  return true;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Tool handlers ---

async function handleRequest(req: MemoryRequest): Promise<unknown> {
  const { tool, args } = req;
  const sourceGroup = (args.source_group as string) || 'unknown';
  const isMain = args.is_main === true;

  switch (tool) {
    case 'save_memory': {
      if (!canWriteGlobal(isMain)) {
        throw new Error(
          'Global write denied: MEMORY_GLOBAL_WRITE_POLICY=main_only and this is not the main group',
        );
      }

      const content = args.content as string;
      const type = args.type as string;
      const tags = (args.tags as string[]) || [];

      // Dedup check
      const existing = readAllGlobalMemories();
      const dupId = findDuplicate(content, existing);
      if (dupId) {
        logger.info(
          { dupId, sourceGroup },
          'Duplicate global memory detected, returning existing',
        );
        return { saved: false, duplicate: true, existing_id: dupId };
      }

      const id = generateId();
      const fileContent = [
        '---',
        `id: ${id}`,
        `type: ${type}`,
        `scope: global`,
        `tags: [${tags.join(', ')}]`,
        `created: ${new Date().toISOString()}`,
        `source_group: ${sourceGroup}`,
        '---',
        '',
        content,
        '',
      ].join('\n');

      fs.mkdirSync(getGlobalMemoryDir(), { recursive: true });
      const filePath = path.join(getGlobalMemoryDir(), `${id}.md`);
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, fileContent);
      fs.renameSync(tempPath, filePath);

      regenerateGlobalIndex();

      logger.info({ id, type, sourceGroup }, 'Global memory saved');
      return { saved: true, id, scope: 'global' };
    }

    case 'search_memory': {
      const query = ((args.query as string) || '').toLowerCase();
      const memories = readAllGlobalMemories();

      const matches = memories
        .filter((m) => {
          if (!query) return true;
          return (
            m.content.toLowerCase().includes(query) ||
            m.tags.some((t) => t.toLowerCase().includes(query)) ||
            m.type.toLowerCase().includes(query)
          );
        })
        .sort((a, b) => b.created.localeCompare(a.created))
        .slice(0, 50);

      return matches.map(memoryToSummary);
    }

    case 'list_memories': {
      const tag = args.tag as string | undefined;
      const type = args.type as string | undefined;
      const memories = readAllGlobalMemories();

      const filtered = memories
        .filter((m) => {
          if (tag && !m.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
            return false;
          if (type && m.type !== type) return false;
          return true;
        })
        .sort((a, b) => b.created.localeCompare(a.created))
        .slice(0, 50);

      return filtered.map(memoryToSummary);
    }

    case 'delete_memory': {
      if (!canWriteGlobal(isMain)) {
        throw new Error(
          'Global write denied: MEMORY_GLOBAL_WRITE_POLICY=main_only and this is not the main group',
        );
      }

      const id = args.id as string;
      const filePath = path.join(getGlobalMemoryDir(), `${id}.md`);

      if (!fs.existsSync(filePath)) {
        return { deleted: false, error: 'Memory not found' };
      }

      fs.unlinkSync(filePath);
      regenerateGlobalIndex();

      logger.info({ id, sourceGroup }, 'Global memory deleted');
      return { deleted: true, id, scope: 'global' };
    }

    default:
      throw new Error(`Unknown memory tool: ${tool}`);
  }
}

/**
 * Process all pending memory IPC requests in a given group's IPC directory.
 */
export function processMemoryIpc(groupIpcDir: string): void {
  const requestsDir = path.join(groupIpcDir, 'memory', 'requests');
  const responsesDir = path.join(groupIpcDir, 'memory', 'responses');

  if (!fs.existsSync(requestsDir)) return;

  let files: string[];
  try {
    files = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const requestPath = path.join(requestsDir, file);

    let req: MemoryRequest;
    try {
      req = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
    } catch (err) {
      logger.error({ file, err }, 'Failed to parse memory IPC request');
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
          'Memory IPC error',
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
