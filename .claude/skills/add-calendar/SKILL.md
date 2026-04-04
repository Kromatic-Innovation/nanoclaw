---
name: add-calendar
description: Add Google Calendar integration (list calendars, events, create/update/delete/search events) to NanoClaw via the IPC bridge pattern.
---

# Add Google Calendar

Adds Google Calendar read/write tools to NanoClaw. The agent inside containers can list calendars, list/search/create/update/delete events, and inspect attendee responses including counter-proposals. All tools support multi-account access.

## What It Provides

Seven MCP tools exposed to the agent inside containers:

| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars for the account |
| `list_events` | List upcoming events (by days, time range, or query) |
| `search_events` | Free-text search across calendar events |
| `get_event` | Full event detail including attendee status and counter-proposals |
| `create_event` | Create a new event with title, time, location, description |
| `update_event` | Update an existing event by ID |
| `delete_event` | Permanently delete an event by ID |

## Phase 1: Pre-flight

### Check if already applied

```bash
ls src/calendar-ipc.ts 2>/dev/null && echo "Already applied — skip to Phase 4" || echo "Not yet applied"
```

If `src/calendar-ipc.ts` exists, the code is already merged. Skip to Phase 4 (Configure).

### Prerequisites

This skill depends on **Google OAuth credentials** being set up. The `skill/google-auth` branch must be merged first (it provides `scripts/google_reauth.py` and the credential storage layout). If you have not merged it yet:

```bash
git fetch origin skill/google-auth
git merge origin/skill/google-auth
```

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/calendar
git merge origin/skill/calendar
```

This merges in:

- `src/calendar-ipc.ts` — host-side IPC handler that dispatches requests to the Python wrapper
- `container/agent-runner/src/calendar-mcp-stdio.ts` — container-side MCP server exposing calendar tools
- `scripts/google_calendar_wrapper.py` — Python script that calls the Google Calendar API
- Integration hooks in `src/ipc.ts` (calendar IPC polling), `src/container-runner.ts` (IPC directory creation), and `container/agent-runner/src/index.ts` (MCP server registration and tool allowlist)

If the merge reports conflicts, resolve by reading both sides. Conflicts are most likely in `src/ipc.ts`, `src/container-runner.ts`, or `container/agent-runner/src/index.ts` where other skills also add integration hooks.

### Install and build

```bash
npm install
npm run build
```

Build must complete cleanly before proceeding.

## Phase 3: Build Container

The agent container includes the calendar MCP server, so it must be rebuilt:

```bash
# Clear stale per-group agent-runner copies
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true

# Rebuild the container
cd container && ./build.sh
```

## Phase 4: Configure

### Google OAuth setup

The calendar wrapper loads credentials in this order:

1. **Credentials file** (recommended): `~/.config/nanoclaw/secrets/google-gmail.json` or `~/.openclaw/secrets/google-gmail.json`
2. **1Password** (fallback): reads from item set via `GOOGLE_1PASSWORD_ITEM` env var

If credentials are not yet configured, run the reauth script with the Calendar scope:

```bash
python3 scripts/google_reauth.py
```

This opens a browser for Google OAuth consent. Grant access to Google Calendar when prompted.

### Multi-account setup

The `account` parameter controls which Google account is used. It accepts `"1"` (primary, default) or `"2"` (secondary).

- **Account 1** reads from `google-gmail.json` (or the `GOOGLE_CREDS_FILE` env var)
- **Account 2** reads from `google-gmail-2.json` (or the `GOOGLE_CREDS_FILE_2` env var)

To set up a second account:

```bash
python3 scripts/google_reauth.py --account 2
```

The credentials file must contain `client_id`, `client_secret`, and `refresh_token`.

## Phase 5: Verify

### Restart the service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

### Test the wrapper directly

```bash
python3 scripts/google_calendar_wrapper.py calendars
```

Expected output: JSON array of calendars with `id`, `summary`, and `primary` fields.

```bash
python3 scripts/google_calendar_wrapper.py list --days 7
```

Expected output: JSON array of upcoming events with `id`, `summary`, `start`, `end` fields.

### Test from a channel

Send a message to the agent through any connected channel:

> What's on my calendar this week?

The agent should use `list_events` and return a summary. You can also test:

> Create a meeting called "Test Event" tomorrow at 2pm for 30 minutes

Then verify with:

```bash
python3 scripts/google_calendar_wrapper.py list --days 2
```

### Test multi-account (if configured)

```bash
python3 scripts/google_calendar_wrapper.py --account 2 calendars
```

## How It Works

### Architecture

The calendar integration uses NanoClaw's IPC bridge pattern:

```
Container (agent)          Host (NanoClaw)
+-----------------------+  +---------------------------+
| calendar-mcp-stdio.ts |  | calendar-ipc.ts           |
| (MCP server)          |  | (IPC watcher)             |
|                       |  |                           |
| Writes JSON request   |->| Reads request from        |
| to /workspace/ipc/    |  | {group}/calendar/requests/|
| calendar/requests/    |  |                           |
|                       |  | Calls google_calendar_    |
| Polls for response    |<-| wrapper.py                |
| in /workspace/ipc/    |  |                           |
| calendar/responses/   |  | Writes response to        |
+-----------------------+  | {group}/calendar/responses|
                           +---------------------------+
```

1. The agent calls a calendar tool (e.g., `list_events`)
2. `calendar-mcp-stdio.ts` writes a JSON request to the IPC requests directory
3. `calendar-ipc.ts` on the host picks up the request during its poll cycle
4. The host runs `google_calendar_wrapper.py` with the appropriate CLI arguments
5. The wrapper authenticates via OAuth and calls the Google Calendar API
6. The response is written back to the IPC responses directory
7. The container-side MCP server reads the response and returns it to the agent

### Files

| File | Side | Purpose |
|------|------|---------|
| `src/calendar-ipc.ts` | Host | Watches IPC dir, dispatches to Python wrapper |
| `src/ipc.ts` | Host | Calls `processCalendarIpc()` in the poll loop |
| `src/container-runner.ts` | Host | Creates calendar IPC directories for each group |
| `container/agent-runner/src/calendar-mcp-stdio.ts` | Container | MCP server exposing tools to the agent |
| `container/agent-runner/src/index.ts` | Container | Registers `google-calendar` MCP server |
| `scripts/google_calendar_wrapper.py` | Host | Calls Google Calendar API via OAuth |

## Troubleshooting

### "Token refresh failed" or 401 errors

OAuth credentials are expired or revoked. Re-authorize:

```bash
python3 scripts/google_reauth.py
```

### "calendar wrapper error" in logs

Test the wrapper directly to isolate the issue:

```bash
python3 scripts/google_calendar_wrapper.py calendars
```

Common causes:
- Missing credentials file — check `~/.config/nanoclaw/secrets/google-gmail.json` exists
- Missing fields in credentials — file must contain `client_id`, `client_secret`, `refresh_token`
- Calendar API not enabled — enable it at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com

### "Calendar IPC timeout after 30000ms"

The container-side MCP server gave up waiting for a host response. Check:
- NanoClaw is running (the host process handles IPC)
- Logs for errors: `tail -f logs/nanoclaw.log | grep -i calendar`
- IPC directories exist: `ls data/sessions/*/ipc/calendar/`

### Agent does not have calendar tools

Verify the MCP server is registered. Check `container/agent-runner/src/index.ts` for:
- `'mcp__google-calendar__*'` in the `allowedTools` array
- `'google-calendar'` entry in the `mcpServers` config

If missing, the merge may not have applied cleanly. Re-check the merge.

### Multi-account "Creds file not found for account 2"

Set up the second account:

```bash
python3 scripts/google_reauth.py --account 2
```

This creates `~/.config/nanoclaw/secrets/google-gmail-2.json`.

### Container has stale code

After rebuilding, old per-group copies may persist:

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
cd container && ./build.sh
```

Then restart the service.

## Removal

1. Remove calendar-specific files:

```bash
rm src/calendar-ipc.ts
rm container/agent-runner/src/calendar-mcp-stdio.ts
rm scripts/google_calendar_wrapper.py
rm -rf .claude/skills/add-calendar
```

2. Remove integration hooks from these files:
   - `src/ipc.ts` — remove `import { processCalendarIpc }` and the `processCalendarIpc()` call
   - `src/container-runner.ts` — remove the `calendar/requests` and `calendar/responses` `mkdirSync` lines
   - `container/agent-runner/src/index.ts` — remove `'mcp__google-calendar__*'` from `allowedTools` and the `'google-calendar'` MCP server entry

3. Rebuild and restart:

```bash
npm run build
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
cd container && ./build.sh

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
systemctl --user restart nanoclaw
```
