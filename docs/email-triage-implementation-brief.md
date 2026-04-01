# Email Triage Implementation Brief

**Status:** In progress (2026-03-30)
**Plan:** ~/.claude/plans/cuddly-noodling-church.md

## What We're Building

A contact-aware, permission-gated email triage system for NanoClaw's daily briefing pipeline.

## Key Decisions Made

- **Contact DB:** Google Sheets (4 tabs: Email Contacts, Tag Rules, Triage Log, Programmatic Rules)
- **Enforcement:** Both layers (Tier 0 attaches permissions to WorkItems + hook guards gmail_wrapper calls)
- **Dedup:** Gmail labels (`claw/triaged`, `claw/drafted`, `claw/spam`, `claw/escalated`, `claw/pending`)
- **Tier 2 model:** Opus 4.6 (not Sonnet)
- **Schedule:** 06:00 AM local time daily (`0 6 * * *`)
- **Budget:** Keep existing $3/day, $15/week

## Tag-to-Action Mapping

| Tag          | Allowed Actions   |
| ------------ | ----------------- |
| friend       | draft             |
| sales-lead   | draft             |
| contact      | send              |
| client       | draft             |
| ai-friendly  | send              |
| mailing-list | add-label, delete |
| spam         | add-label, delete |

`claw/*` label operations are always allowed (exempt from hooks).

## Task Checklist

- [ ] Task 5: `scripts/sheets_contact_db.py` — Sheets API client (lookup, log-triage, get-rules, suggest-rule)
- [ ] Task 6: `scripts/email-action-guard.py` — hook enforcement wrapper
- [ ] Task 7: Update `scripts/fetch-daily-data.py` — enrich WorkItems, change Gmail query
- [ ] Task 8: Update `tickle-stick.yaml` — Tier 1 (rule-aware + logging) and Tier 2 (permission-gated, Opus 4.6)
- [ ] Task 9: Add `syncDailyBriefing()` to `src/task-scheduler.ts` + config
- [ ] Task 10: Post-pipeline Gmail labeling step

## Critical File Paths

| File                                             | Role                       |
| ------------------------------------------------ | -------------------------- |
| `~/Code/nanoclaw/scripts/fetch-daily-data.py`    | Tier 0 gather (modify)     |
| `~/Code/nanoclaw/tickle-stick.yaml`              | Pipeline config (modify)   |
| `~/Code/nanoclaw/config/private.yaml`            | Scheduling config (modify) |
| `~/Code/nanoclaw/src/task-scheduler.ts`          | Scheduler sync (modify)    |
| `~/Code/nanoclaw/scripts/sheets_contact_db.py`   | NEW — Sheets client        |
| `~/Code/nanoclaw/scripts/email-action-guard.py`  | NEW — Action guard         |
| `~/.openclaw/workspace/scripts/gmail_wrapper.py` | Gmail API (read-only dep)  |
| `~/.openclaw/secrets/google-gmail.json`          | OAuth credentials          |

## Google Sheets Structure

### Email Contacts

Columns: email, name, tags, allowed_actions, drafting_context, notes

### Tag Rules

Columns: tag, allowed_actions, description

### Triage Log

Columns: timestamp, email_id, from, subject, category, action_taken, confidence, reasoning, rule_matched

### Programmatic Rules

Columns: rule_id, condition, action, description
Conditions: `from_domain:`, `subject_contains:`, `from_email:`, `has_unsubscribe:`

## Gmail Query (dedup)

```
in:inbox is:unread -label:claw-triaged -label:claw-drafted -label:claw-escalated -label:claw-pending
```

## Existing Infrastructure

- `syncScheduledRepoMaintenance()` in task-scheduler.ts — pattern to follow for `syncDailyBriefing()`
- `parseYaml` already imported in task-scheduler.ts
- `createTask`, `getAllRegisteredGroups`, `getAllTasks`, `updateTask` already imported
- Gmail wrapper supports: list, get, thread, label-create, label-add, label-remove, draft-new, draft-reply, draft-reply-all, send-new, send-reply-all
- Self-emails to exclude: tristan@kromatic.com, tk@tristankromer.com
