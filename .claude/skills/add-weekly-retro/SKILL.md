---
name: add-weekly-retro
description: Add weekly retrospective pipeline — gathers costs, errors, and task stats, then synthesizes a retro report.
---

# Add Weekly Retro Pipeline

This skill adds the `weekly-retro` pipeline to NanoClaw via [tickle-stick](https://github.com/qwibitai/tickle-stick). It queries NanoClaw's SQLite database for pipeline costs, task run errors, and task statistics, then synthesizes a weekly retrospective.

**What you get:**

- **Gather** — Queries `store/messages.db` for pipeline costs, task errors, and run statistics from the past 7 days
- **Classify** — Cheap model flags concerning trends for deeper analysis
- **Synthesize** — Full model produces a two-part retro: facts on the ground + what went well / what didn't / what to change

## Prerequisites

Merge this skill branch first:

1. `skill/add-tickle-stick` — pipeline runner framework

## Installation

```bash
git fetch origin skill/weekly-retro
git merge origin/skill/weekly-retro
npm install
npm run build
```

## Configuration

### Scheduled task

Run the weekly retro automatically (e.g. every Monday morning):

```json
{
  "type": "schedule_task",
  "prompt": "pipeline:weekly-retro",
  "schedule_type": "cron",
  "schedule_value": "0 8 * * 1",
  "targetJid": "<your-main-group-jid>"
}
```

### Triage provider

To enable the classify stage, uncomment the `triageProvider` section in `tickle-stick.yaml` and set your API key.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/fetch-weekly-data.py` | Queries SQLite for pipeline costs, task errors, task run stats |

## Removal

1. Remove the `weekly-retro` pipeline section from `tickle-stick.yaml`
2. Delete the script: `rm scripts/fetch-weekly-data.py`
3. Delete this skill: `rm -rf .claude/skills/add-weekly-retro`
4. Remove any scheduled tasks for `pipeline:weekly-retro`
5. Rebuild: `npm run build`
