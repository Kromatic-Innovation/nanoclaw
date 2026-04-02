---
name: add-maps
description: Google Maps directions and travel time. Adds host-side IPC handler and container MCP server for route computation via Google Routes API.
---

# Add Google Maps Integration

This skill adds Google Maps support to NanoClaw as an IPC-based tool. The agent can request directions, travel time, and distance between locations.

## Prerequisites

- `skill/google-auth` must be applied first (shared Google OAuth credentials)

## Phase 1: Pre-flight

### Check if already applied

Check if `src/maps-ipc.ts` exists. If it does, the code changes are already in place — skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/maps
git merge origin/skill/maps
```

This merges in:

- `scripts/google_maps_wrapper.py` — Python wrapper for Google Routes API
- `src/maps-ipc.ts` — Host-side IPC handler (watches `{group}/maps/requests/`)
- `container/agent-runner/src/maps-mcp-stdio.ts` — Container-side MCP server exposing Maps tools to the agent
- IPC wiring in `src/ipc.ts` and `src/container-runner.ts`
- MCP server registration in `container/agent-runner/src/index.ts`

### Validate code changes

```bash
npm install
npm run build
```

## Phase 3: Setup

Google Maps uses the same OAuth credentials as Gmail/Calendar. If those are already configured, no additional setup is needed.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test directions

```bash
python3 scripts/google_maps_wrapper.py directions --origin "New York, NY" --destination "Boston, MA"
```

### Test distance

```bash
python3 scripts/google_maps_wrapper.py distance --origin "New York, NY" --destination "Boston, MA"
```

Once verified, tell the user:

> Google Maps is connected! You can now ask for directions and travel time, e.g.:
>
> `How long will it take to drive from home to the airport?`

## Troubleshooting

### Maps wrapper not responding

Test the wrapper directly:

```bash
python3 scripts/google_maps_wrapper.py directions --origin "NYC" --destination "Boston"
```

### OAuth credentials missing

Maps uses the same Google OAuth credentials as Gmail/Calendar. Ensure `skill/google-auth` has been applied and credentials are configured.

## Removal

1. Remove Maps IPC handler registration from `src/ipc.ts`
2. Remove Maps mount from `src/container-runner.ts`
3. Remove `container/agent-runner/src/maps-mcp-stdio.ts`
4. Remove `src/maps-ipc.ts`
5. Remove `scripts/google_maps_wrapper.py`
6. Rebuild and restart
