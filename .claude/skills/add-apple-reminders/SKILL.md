---
name: add-apple-reminders
description: Apple Reminders list/create/complete/delete. macOS only, uses JXA via osascript. Adds host-side IPC handler and container MCP server.
---

# Add Apple Reminders Integration

This skill adds Apple Reminders support to NanoClaw as an IPC-based tool. The agent can list, create, complete, and delete reminders using JXA (JavaScript for Automation) scripts executed via `osascript`.

## Prerequisites

- macOS only (requires `osascript` with JXA support)
- Reminders app configured with at least one list

## Phase 1: Pre-flight

### Check if already applied

Check if `src/reminders-ipc.ts` exists. If it does, the code changes are already in place — skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/apple-reminders
git merge origin/skill/apple-reminders
```

This merges in:

- `src/reminders-ipc.ts` — Host-side IPC handler (watches `{group}/reminders/requests/`, executes JXA via `osascript`)
- `container/agent-runner/src/reminders-mcp-stdio.ts` — Container-side MCP server exposing Reminders tools to the agent
- `mcp-servers/apple-reminders/` — MCP server package for Apple Reminders
- IPC wiring in `src/ipc.ts` and `src/container-runner.ts`
- MCP server registration in `container/agent-runner/src/index.ts`

### Validate code changes

```bash
npm install
npm run build
```

## Phase 3: Setup

No additional credentials are needed. Apple Reminders uses the system Reminders app via JXA.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS only
```

## Phase 4: Verify

### Test from command line

```bash
osascript -l JavaScript -e 'Application("Reminders").defaultList().reminders().length'
```

Once verified, tell the user:

> Apple Reminders is connected! You can now manage reminders, e.g.:
>
> `Add a reminder to buy groceries tomorrow` or `Show my reminders list`

## Troubleshooting

### osascript permission denied

Grant Automation permission to Terminal (or the NanoClaw process) in System Settings > Privacy & Security > Automation.

### No reminders lists found

Open the Reminders app and ensure at least one list exists.

## Removal

1. Remove Reminders IPC handler registration from `src/ipc.ts`
2. Remove Reminders mount from `src/container-runner.ts`
3. Remove `container/agent-runner/src/reminders-mcp-stdio.ts`
4. Remove `src/reminders-ipc.ts`
5. Remove `mcp-servers/apple-reminders/`
6. Rebuild and restart
