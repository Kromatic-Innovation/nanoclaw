---
name: add-self-reset
description: Add service management MCP tools (restart, reload config, status) so the agent can self-restart NanoClaw or check service health. Uses file-based IPC between container and host. Main-group only for restart/reload; any group can check status.
---

# Add Self-Reset / Service Management Tools

Adds three MCP tools that let the container agent manage the NanoClaw host service:

- **restart_service** — gracefully restart NanoClaw (main group only)
- **reload_config** — send SIGHUP to reload configuration without full restart (main group only)
- **get_service_status** — check uptime, version, PID, and service manager status (any group)

## What It Provides

| Tool | Scope | Description |
|------|-------|-------------|
| `restart_service` | Main only | Schedules a service restart via launchctl (macOS) or systemctl (Linux). Returns immediately; restart happens ~1s later. |
| `reload_config` | Main only | Sends SIGHUP to the host process to trigger config reload without downtime. |
| `get_service_status` | Any group | Returns version, PID, uptime, start time, and service manager status output. |

## Phase 1: Pre-flight

Check if the service IPC handler already exists:

```bash
test -f src/service-ipc.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/self-reset
git merge upstream/skill/self-reset
```

> **Note:** `upstream` is the remote pointing to `qwibitai/nanoclaw`. If using a different remote name, substitute accordingly.

This adds or modifies:

- `src/service-ipc.ts` — host-side IPC handler that processes restart, reload, and status requests
- `src/ipc.ts` — integrates service IPC polling into the existing IPC watcher loop
- `src/container-runner.ts` — creates `service/requests/` and `service/responses/` directories in IPC mounts
- `container/agent-runner/src/service-mcp-stdio.ts` — stdio MCP server exposing the three tools inside the container
- `container/agent-runner/src/index.ts` — registers the `nanoclaw-service` MCP server and allows its tools

### Validate

```bash
npm test
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Integration Test

1. Start NanoClaw in dev mode: `npm run dev`
2. From the **main group** (self-chat), ask the agent: "What is the service status?"
3. Verify:
   - The agent calls `get_service_status` via the `nanoclaw-service` MCP server
   - The response includes version, PID, uptime, and service manager status
4. From the **main group**, ask the agent: "Restart the service because I updated config"
5. Verify:
   - The agent calls `restart_service` with a reason string
   - The response confirms restart is scheduled
   - The service restarts ~1 second later (check process PID changes)
   - The agent's container exits cleanly before the host restarts
6. From the **main group**, ask the agent: "Reload the config"
7. Verify:
   - The agent calls `reload_config` with a reason string
   - The response confirms SIGHUP was sent
   - The service continues running (no restart, same PID)
8. From a **non-main group**, ask the agent to restart the service
9. Verify:
   - The response returns an error: "Only the main group can restart the service"
   - No restart occurs
10. From a **non-main group**, ask the agent for service status
11. Verify:
    - Status is returned successfully (status is allowed from any group)

### Validation on Fresh Clone

```bash
git clone <your-fork> /tmp/nanoclaw-test
cd /tmp/nanoclaw-test
claude  # then run /add-self-reset
npm run build
npm test
./container/build.sh
# Manual: ask for service status from main group, verify response
# Manual: request restart from main group, verify service restarts
# Manual: request restart from non-main group, verify denial
```

## How It Works

### Architecture

```
Container                          Host
---------                          ----
service-mcp-stdio.ts               service-ipc.ts
  |                                  |
  |-- writes request JSON -->  /workspace/ipc/service/requests/
  |                                  |-- reads request, executes
  |<-- reads response JSON --  /workspace/ipc/service/responses/
```

The container agent calls MCP tools exposed by `service-mcp-stdio.ts`. This process writes JSON request files to a shared volume. The host-side IPC watcher (`ipc.ts`) polls the requests directory, delegates to `service-ipc.ts`, and writes JSON response files back. The container process polls for responses with a 100ms interval and a 30-second timeout.

### Platform Detection

Restart and status commands auto-detect the platform:
- **macOS**: uses `launchctl kickstart` / `launchctl print` with the user's GUI domain
- **Linux**: uses `systemctl --user restart` / `systemctl --user status`

### Security

- **restart_service** and **reload_config** require `isMain === true` (main group only). Non-main groups receive an error.
- **get_service_status** is available to all groups (read-only, no side effects).
- All restart/reload actions are logged with the caller-provided reason for audit trail.
- Restart is scheduled with a 1-second delay so the IPC response can be written back before the process exits.

## Removal

To remove the self-reset capability:

1. Delete `src/service-ipc.ts`
2. Delete `container/agent-runner/src/service-mcp-stdio.ts`
3. Remove the `processServiceIpc` call and import from `src/ipc.ts`
4. Remove the `service/requests` and `service/responses` mkdir calls from `src/container-runner.ts`
5. Remove the `nanoclaw-service` MCP server config and `mcp__nanoclaw-service__*` permission from `container/agent-runner/src/index.ts`
6. Rebuild: `npm run build && ./container/build.sh`
