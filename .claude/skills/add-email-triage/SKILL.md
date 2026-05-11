---
name: add-email-triage
description: Add email triage pipeline — classifies, drafts replies, and synthesizes a daily briefing from Gmail, Calendar, and Reminders.
---

# Add Email Triage Pipeline

This skill adds the `daily-briefing` pipeline to NanoClaw via [tickle-stick](https://github.com/qwibitai/tickle-stick). It processes incoming emails through a 4-stage pipeline: gather data, classify spam, reason about each email, and synthesize a conversational daily briefing.

**What you get:**

- **Gather** — Fetches unread Gmail, today's calendar events, and due reminders
- **Classify** — Cheap model pre-screens for obvious spam
- **Reason** — Full model drafts replies, sends messages, or escalates per contact rules
- **Synthesize** — Produces a concise daily briefing with action items
- **Post-hooks** — Auto-labels processed emails (claw/spam, claw/drafted, claw/triaged)
- **Email action guard** — Safety layer that validates Gmail mutations against a contact database

## Prerequisites

Merge these skill branches first:

1. `skill/add-tickle-stick` — pipeline runner framework
2. `skill/gmail` — Gmail IPC integration
3. `skill/sheets` — Google Sheets (for contact database with permissions)
4. `skill/calendar` — Google Calendar (for daily briefing data)

## Installation

```bash
git fetch origin skill/email-triage
git merge origin/skill/email-triage
npm install
npm run build
```

## Configuration

### tickle-stick.yaml

The pipeline is defined in `tickle-stick.yaml` at the project root. Key settings:

- **Budget** — Daily/weekly spend caps for model calls
- **Triage provider** — Uncomment `triageProvider` section and set your API key env var
- **Pipeline prompts** — Customize the classify/reason/synthesize prompts

### Contact database (Google Sheets)

The email action guard checks a Google Sheets contact database to determine allowed actions per contact (draft, send, escalate). Set up the spreadsheet via the `skill/sheets` integration.

### Scheduled task

To run the daily briefing automatically, create a scheduled task:

```json
{
  "type": "schedule_task",
  "prompt": "pipeline:daily-briefing",
  "schedule_type": "cron",
  "schedule_value": "0 7 * * *",
  "targetJid": "<your-main-group-jid>"
}
```

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/fetch-daily-data.py` | Gathers Gmail, Calendar, Reminders data as WorkItem[] |
| `scripts/apply-spam-labels.py` | Labels classified spam with claw/spam |
| `scripts/apply-draft-labels.py` | Labels drafted emails with claw/drafted |
| `scripts/apply-triaged-labels.py` | Labels all processed emails with claw/triaged |
| `scripts/email-action-guard.py` | Validates Gmail mutations against contact permissions |

## Removal

1. Delete `tickle-stick.yaml` (or remove the `daily-briefing` pipeline section)
2. Delete the scripts: `rm scripts/fetch-daily-data.py scripts/apply-*.py scripts/email-action-guard.py`
3. Delete this skill: `rm -rf .claude/skills/add-email-triage`
4. Remove any scheduled tasks for `pipeline:daily-briefing`
5. Rebuild: `npm run build`
