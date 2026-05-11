---
name: add-calendar-mgmt
description: Add calendar management pipeline — fetches events, classifies urgency, identifies conflicts and prep needs.
---

# Add Calendar Management Pipeline

This skill adds the `calendar-management` pipeline to NanoClaw via [tickle-stick](https://github.com/qwibitai/tickle-stick). It fetches today's and tomorrow's calendar events, classifies them by urgency, and identifies conflicts, prep needs, and scheduling optimizations.

**What you get:**

- **Gather** — Fetches events from Google Calendar (multi-account support)
- **Classify** — Cheap model flags conflicts, double-bookings, and meetings needing prep
- **Reason** — Full model analyzes flagged items: conflict resolution, prep suggestions, scheduling optimization

## Prerequisites

Merge these skill branches first:

1. `skill/add-tickle-stick` — pipeline runner framework
2. `skill/calendar` — Google Calendar IPC integration

## Installation

```bash
git fetch origin skill/calendar-mgmt
git merge origin/skill/calendar-mgmt
npm install
npm run build
```

## Configuration

### Scheduled task

Run calendar management daily:

```json
{
  "type": "schedule_task",
  "prompt": "pipeline:calendar-management",
  "schedule_type": "cron",
  "schedule_value": "0 7 * * *",
  "targetJid": "<your-main-group-jid>"
}
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/fetch-calendar-data.py` | Fetches today's and tomorrow's events from Google Calendar |

## Removal

1. Remove the `calendar-management` pipeline section from `tickle-stick.yaml`
2. Delete the script: `rm scripts/fetch-calendar-data.py`
3. Delete this skill: `rm -rf .claude/skills/add-calendar-mgmt`
4. Remove any scheduled tasks for `pipeline:calendar-management`
5. Rebuild: `npm run build`
