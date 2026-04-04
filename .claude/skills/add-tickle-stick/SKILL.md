---
name: add-tickle-stick
description: Add tickle-stick pipeline management to NanoClaw agents. Agents can define, list, update, and delete multi-stage triage pipelines via YAML config. Supports budget controls and per-stage types (script, model, callback). Triggers on "add tickle-stick", "triage pipelines", "pipeline management", "tickle stick".
---

# Add Tickle Stick

Adds a pipeline management system ("tickle stick") to NanoClaw agents. Agents get MCP tools to create and manage multi-stage triage pipelines defined in a `tickle-stick.yaml` config file at the project root.

**What is a tickle stick?**

A tickle stick is a named, multi-stage triage pipeline. Each pipeline has an ordered list of stages that can be scripts, model calls, or callbacks. Pipelines are defined in YAML and managed through MCP tools exposed to the agent. The host reads and writes the YAML config; the container communicates via an IPC bridge.

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f src/tickle-stick-ipc.ts && echo "ALREADY_APPLIED" || echo "NOT_YET_APPLIED"
```

If already applied, skip to Phase 4 (configure) or Phase 5 (verify).

## Phase 2: Apply Code Changes

### Option A: Same-repo branch (default)

If `skill/tickle-stick` branch exists on origin:

```bash
git fetch origin skill/tickle-stick
git merge origin/skill/tickle-stick
```

### Option B: External repo

If installing from a different NanoClaw fork:

```bash
git remote add tickle-upstream https://github.com/YOUR-ORG/nanoclaw.git
git fetch tickle-upstream skill/tickle-stick
git merge tickle-upstream/skill/tickle-stick
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
ls src/tickle-stick-ipc.ts container/agent-runner/src/tickle-stick-mcp-stdio.ts
```

## Phase 3: Build Container

Rebuild the agent container to include the new MCP server:

```bash
./container/build.sh
```

## Phase 4: Configure

Optionally seed an initial `tickle-stick.yaml` at the project root. The file is created automatically when the first pipeline is created via MCP tools, but you can pre-populate it:

```yaml
tickleStick:
  budget:
    maxStagesPerPipeline: 10
    maxPipelines: 20
  pipelines: {}
```

No environment variables are required. The config file path is `tickle-stick.yaml` in the project root.

## Phase 5: Verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Ask the user to test by sending a message to any group:

> Send a message like "List my tickle-stick pipelines" to any chat group.

Check logs for tickle-stick IPC activity:

```bash
tail -20 logs/nanoclaw.log | grep -i tickle
```

## How It Works

### Agent tools

The agent gets six MCP tools:

| Tool              | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `list_pipelines`  | List all triage pipelines with stage summaries        |
| `get_pipeline`    | Get full definition of a pipeline by name             |
| `create_pipeline` | Create a new pipeline from a JSON definition          |
| `update_pipeline` | Replace an existing pipeline definition               |
| `delete_pipeline` | Remove a pipeline by name                             |
| `get_budget`      | Get current budget configuration                      |

### YAML format

Pipeline definitions live in `tickle-stick.yaml`:

```yaml
tickleStick:
  budget:
    maxStagesPerPipeline: 10
    maxPipelines: 20
  pipelines:
    daily-briefing:
      stages:
        - name: gather
          type: script
          # script-specific fields
        - name: summarize
          type: model
          # model-specific fields
        - name: notify
          type: callback
          # callback-specific fields
```

Each stage requires `name` and `type`. Type-specific fields depend on the stage type (script, model, or callback).

### Architecture

Pipeline management operations use the IPC bridge. The container-side MCP server (`tickle-stick-mcp-stdio.ts`) writes JSON request files to `/workspace/ipc/tickle-stick/requests/`. The host-side handler (`src/tickle-stick-ipc.ts`) reads the requests, applies changes to `tickle-stick.yaml`, and writes JSON responses to `/workspace/ipc/tickle-stick/responses/`. The container polls for the response file.

The `yaml` npm package (v2.x) is added as a dependency for reading and writing the YAML config.

## Removal

To remove the tickle-stick skill:

1. Delete the implementation files: `rm src/tickle-stick-ipc.ts container/agent-runner/src/tickle-stick-mcp-stdio.ts`
2. Remove registration from `src/ipc.ts` (the `processTickleStickIpc` import and call)
3. Remove registration from `container/agent-runner/src/index.ts` (the `tickle-stick` MCP server config and `mcp__tickle-stick__*` permission)
4. Remove IPC dir creation from `src/container-runner.ts` (the `tickle-stick` mkdir lines)
5. Remove the `yaml` dependency: `npm uninstall yaml`
6. Rebuild: `npm run build && ./container/build.sh`

The `tickle-stick.yaml` config file is preserved (not deleted) so pipeline definitions are not lost.
