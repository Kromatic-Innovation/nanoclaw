---
name: add-calendar
description: Add Google Calendar integration (list calendars, events, create/update events) to NanoClaw.
---

# Add Google Calendar

Adds Google Calendar read/write via the IPC bridge pattern.

## Prerequisites

- Merge `skill/google-auth` first
- Run `python3 scripts/google_reauth.py` to authorize Calendar scope

## Installation

```bash
git fetch origin skill/calendar
git merge origin/skill/calendar
npm run build && ./container/build.sh
```

## Tools

- `list_calendars` — list all calendars
- `list_events` — list upcoming events (by days or time range)
- `create_event` — create a new event
- `update_event` — update an existing event

All tools accept `account: "1" | "2"` for multi-account support.

## Verification

```bash
python3 scripts/google_calendar_wrapper.py list-events --days 7
```

## Removal

```bash
rm src/calendar-ipc.ts container/agent-runner/src/calendar-mcp-stdio.ts scripts/google_calendar_wrapper.py
rm -rf .claude/skills/add-calendar
# Remove calendar entries from src/ipc.ts, src/container-runner.ts, container/agent-runner/src/index.ts
npm run build
```
