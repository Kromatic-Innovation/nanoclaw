---
name: add-memory
description: Add persistent memory to NanoClaw agents. Agents can save, search, and recall memories across sessions. Supports per-group isolation and shared global memory. Triggers on "add memory", "persistent memory", "agent memory", "remember across sessions".
---

# Add Memory

Adds a persistent, searchable memory system to NanoClaw agents. Agents get MCP tools to save and retrieve memories that survive container restarts.

**Two-tier model:**

- **Group memory** — private to each group, stored locally in the container filesystem
- **Global memory** — shared across all groups, accessible via IPC bridge

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f src/memory-ipc.ts && echo "ALREADY_APPLIED" || echo "NOT_YET_APPLIED"
```

If already applied, skip to Phase 4 (configure) or Phase 5 (verify).

## Phase 2: Apply Code Changes

### Option A: Same-repo branch (default)

If `skill/memory` branch exists on origin:

```bash
git fetch origin skill/memory
git merge origin/skill/memory
```

### Option B: External repo

If installing from a different NanoClaw fork:

```bash
git remote add memory-upstream https://github.com/Kromatic-Innovation/nanoclaw.git
git fetch memory-upstream skill/memory
git merge memory-upstream/skill/memory
```

### Handle merge conflicts

If `package-lock.json` conflicts:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

### Validate

```bash
npm install
npm run build
```

Verify the new files exist:

```bash
ls src/memory-ipc.ts container/agent-runner/src/memory-mcp-stdio.ts
```

## Phase 3: Build Container

Rebuild the agent container to include the new MCP server:

```bash
./container/build.sh
```

## Phase 4: Configure

Ask the user about global memory write policy using `AskUserQuestion`:

> **Who should be able to write global memories?**
>
> - `any` (default) — all groups can save global memories
> - `main_only` — only the main group can write global memories (other groups can still read them)

Add to `.env`:

```bash
# Add if not present
grep -q MEMORY_GLOBAL_WRITE_POLICY .env || echo 'MEMORY_GLOBAL_WRITE_POLICY=any' >> .env
```

Sync to container env:

```bash
mkdir -p data/env && cp .env data/env/env
```

Create global memory directory:

```bash
mkdir -p groups/global/memory
```

## Phase 5: Verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Ask the user to test by sending a message to any group:

> Send a message like "Remember that I prefer metric units" to any chat group.

Then verify memory was saved:

```bash
ls groups/*/memory/*.md 2>/dev/null || echo "No memories saved yet"
```

Check logs for memory IPC activity:

```bash
tail -20 logs/nanoclaw.log | grep -i memory
```

## How It Works

### Agent tools

The agent gets four MCP tools:

| Tool            | What it does                                             |
| --------------- | -------------------------------------------------------- |
| `save_memory`   | Save a memory with scope (global/group), type, and tags  |
| `search_memory` | Search memories by keyword across group, global, or both |
| `list_memories` | List all memories with optional tag/type filters         |
| `delete_memory` | Remove a memory by ID                                    |

### Storage

- **Group memories**: `groups/{folder}/memory/*.md` (markdown with YAML frontmatter)
- **Global memories**: `groups/global/memory/*.md` (same format)
- **Index**: `MEMORY.md` auto-generated in each memory directory

### Architecture

Group-scoped operations happen entirely inside the container (direct filesystem read/write). Global-scoped operations use the IPC bridge — the container writes a request, the host-side handler reads/writes `groups/global/memory/`, and returns the response.

## Removal

To remove the memory skill:

1. Delete the memory files: `rm src/memory-ipc.ts container/agent-runner/src/memory-mcp-stdio.ts`
2. Remove registration from `src/ipc.ts` (the `processMemoryIpc` import and call)
3. Remove registration from `container/agent-runner/src/index.ts` (the `memory` MCP server config and `memoryMcpPath`)
4. Remove IPC dir creation from `src/container-runner.ts` (the `memory` mkdir lines)
5. Remove `MEMORY_GLOBAL_WRITE_POLICY` from `.env`
6. Rebuild: `npm run build && ./container/build.sh`

Memory files in `groups/*/memory/` are preserved (not deleted) so data is not lost.
