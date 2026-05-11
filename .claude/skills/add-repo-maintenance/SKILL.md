---
name: add-repo-maintenance
description: Add 3-phase repo maintenance pipeline — triage, plan, and execute automated dependency updates, Sentry fixes, and CI resolution.
---

# Add Repo Maintenance Pipeline

This skill adds a 3-phase repo maintenance pipeline to NanoClaw via [tickle-stick](https://github.com/qwibitai/tickle-stick). It automates dependency management, Sentry regression fixes, CI failure resolution, and stale PR management across multiple repositories.

**What you get:**

- **Triage phase** — Gathers items from Dependabot, Sentry, GitHub Issues, stale PRs; classifies by urgency and MoSCoW priority
- **Plan phase** — Writes implementation plans for items needing human review
- **Execute phase** — Auto-fixes approved items (dependency patches, Sentry regressions, test failures)
- **Label taxonomy** — Structured status/priority labels for tracking (status:draft -> planned -> approved -> in-progress -> staged)
- **MoSCoW prioritization** — must/should/could/wont priority ordering

## Prerequisites

Merge these skill branches first:

1. `skill/add-tickle-stick` — pipeline runner framework
2. `skill/github-issues` — GitHub Issues IPC for issue tracking
3. `skill/sentry` — Sentry IPC for regression detection (optional but recommended)

## Installation

```bash
git fetch origin skill/repo-maintenance
git merge origin/skill/repo-maintenance
npm install
npm run build
```

### Configuration

Copy the example config and fill in your values:

```bash
cp config/private.yaml.example config/private.yaml
```

Edit `config/private.yaml` with:
- **Repo inventory** — list of repos to monitor, organized by daily/weekly tiers
- **Sentry config** — org slug, API key env var, repo-to-project mapping
- **GitHub org** — default org for issue queries

### Scheduled tasks

Run triage daily and execute weekly:

```json
{
  "type": "schedule_task",
  "prompt": "pipeline:repo-maintenance-triage",
  "schedule_type": "cron",
  "schedule_value": "0 6 * * *",
  "targetJid": "<your-main-group-jid>"
}
```

## Pipeline Phases

### 1. Triage (`repo-maintenance-triage`)
Collects items from all configured repos. The gather script (`scripts/repo_maintenance_gather.py`) queries:
- Dependabot alerts (classified by semver: safe/unsafe/urgent)
- Sentry issues (new/regressed, last 24h)
- Stale PRs (over 7 days old)
- CI failures
- Untriaged GitHub issues

Daily repos get full scans every run. Weekly repos get full scans on Thursdays, urgent-only other days.

### 2. Plan (`repo-maintenance-plan`)
For items classified as `needs-reasoning`, the agent explores the codebase and writes implementation plans. Plans are written as GitHub issue comments or `.codex/plans/` files.

### 3. Execute (`repo-maintenance-execute`)
For `status:approved` or auto-fixable items, the agent attempts fixes. Uses `/occam` for the full delivery pipeline (branch, implement, test, PR, CI, merge, staging).

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/repo_maintenance_gather.py` | Collects maintenance items from GitHub, Sentry, Dependabot |

## Removal

1. Remove the three `repo-maintenance-*` pipeline sections from `tickle-stick.yaml`
2. Delete the script: `rm scripts/repo_maintenance_gather.py`
3. Delete config: `rm config/private.yaml.example` (and `config/private.yaml` if present)
4. Delete this skill: `rm -rf .claude/skills/add-repo-maintenance`
5. Remove any scheduled tasks for `pipeline:repo-maintenance-*`
6. Rebuild: `npm run build`
