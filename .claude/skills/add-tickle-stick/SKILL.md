---
name: add-tickle-stick
description: Add Tickle Stick triage — a 4-tier cost hierarchy that deflects cheap messages before spawning an agent container. Includes /budget command for spend tracking.
---

# Add Tickle Stick Triage

This skill adds tickle-stick message triage to NanoClaw. It intercepts inbound messages and deflects simple ones (greetings, commands, keywords) without spawning an expensive agent container.

**What you get:**

- **Tier 0** — Free deterministic matching (regex, keywords, commands)
- **Tier 1** — Optional cheap model triage (~$0.001/msg) for messages that need classification
- **Budget tracking** — Daily/weekly spend caps with alerts to your main group
- **/budget command** — On-demand spend dashboard from any chat

## Phase 1: Pre-flight

### Check if already applied

Check if `src/triage.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Confirm the user wants triage

AskUserQuestion: Tickle Stick adds a message triage layer that deflects simple messages (greetings, /help, keywords) before spawning a container. This saves ~85-95% on agent costs for trivial messages. It's fully configurable via tickle-stick.yaml. Ready to install?

## Phase 2: Apply Code Changes

### Ensure remote

```bash
git remote -v
```

If `tickle-stick-skill` is missing, add it:

```bash
git remote add tickle-stick-skill <nanoclaw-repo-url>
```

### Merge the skill branch

```bash
git fetch tickle-stick-skill skill/add-tickle-stick
git merge tickle-stick-skill/skill/add-tickle-stick || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:

- `src/triage.ts` — Triage module: initializes tickle-stick, wires storage/alerts, exposes budget status
- `tickle-stick.yaml` — Triage configuration (Tier 0 patterns, Tier 1 settings, budget)
- Changes to `src/db.ts` — `triage_events` SQLite table for audit logging
- Changes to `src/index.ts` — Triage gate in message loop, `/budget` command handler, alert sink wiring
- `tickle-stick` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npm test
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Configure triage rules

Edit `tickle-stick.yaml` at the project root. The default configuration includes:

- **Tier 0 patterns**: `/help` command, greeting regex, unsubscribe keywords
- **Tier 1**: System prompt for message classification (disabled until a provider is configured)
- **Budget**: Commented out (opt-in)

Review the defaults and adjust to your needs. Common customizations:

```yaml
tickleStick:
  tier0:
    patterns:
      # Add your own command patterns
      - match: '^/status$'
        type: command
        action: deflect
        response: 'System is running normally.'
    keywords:
      # Add keywords to auto-deflect
      - match: ['pricing', 'cost', 'how much']
        action: deflect
        response: 'Check our pricing at https://example.com/pricing'
```

### Optional: Enable Tier 1 model triage

If you want cheap model-based classification (for messages that don't match Tier 0 patterns), uncomment the `triageProvider` section in `tickle-stick.yaml`:

```yaml
triageProvider:
  provider: openai # "openai" or "anthropic"
  model: gpt-4o-mini # cheap model for triage
  apiKeyEnvVar: OPENAI_API_KEY # which .env var holds the API key
```

This uses whichever API key you already have in `.env` — no new credentials needed. The `apiKeyEnvVar` field tells tickle-stick which environment variable to read.

For custom endpoints (OpenRouter, Ollama, etc.):

```yaml
triageProvider:
  provider: openai
  model: mistral-7b
  apiKeyEnvVar: OPENROUTER_API_KEY
  baseUrl: https://openrouter.ai/api/v1
```

### Optional: Enable budget tracking

Uncomment the `budget` section in `tickle-stick.yaml`:

```yaml
tickleStick:
  # ... tier0, tier1 ...
  budget:
    maxDailySpend: 1.00 # USD — Tier 1 auto-disables when exceeded
    maxWeeklySpend: 5.00 # USD — optional weekly cap
    alerts:
      - at: '80%' # percentage of daily/weekly limit
      - at: 0.50 # absolute USD threshold
    retentionDays: 30 # auto-prune triage events older than this
```

When a budget cap is reached:

- Tier 1 model calls are automatically disabled
- Messages still go through Tier 0 (free deterministic matching)
- An alert is sent to your main group channel

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test triage

Send these messages to a non-main registered chat:

1. **"hello"** — Should get an instant deflected response ("Hello! How can I help you?") without spawning a container
2. **"/help"** — Should respond with the command list
3. **"/budget"** — Should show the budget status dashboard
4. **A complex question** — Should pass through to the full agent as normal

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i triage
```

You should see triage results with tier, action, cost, and latency for each message.

### Check audit trail (if budget enabled)

```bash
sqlite3 store/messages.db "SELECT * FROM triage_events ORDER BY timestamp DESC LIMIT 10"
```

## Troubleshooting

### Triage not working (all messages go to agent)

1. Check `tickle-stick.yaml` exists at project root
2. Check logs for `No tickle-stick.yaml found, triage disabled` or `Failed to initialize triage`
3. Triage is skipped for the main group (by design — admin channel always gets full agent)

### Tier 1 not classifying

1. Verify `triageProvider` section is uncommented in `tickle-stick.yaml`
2. Check that the API key env var exists in `.env`
3. Check logs for `Triage provider configured but API key not found`

### /budget shows "Triage is not enabled"

The triage module didn't initialize. Check the logs at startup for error messages.

### /budget shows "Budget tracking is not configured"

Add a `budget` section to `tickle-stick.yaml` (see Phase 3).

## Removal

To remove Tickle Stick triage:

1. Delete `src/triage.ts`
2. Remove triage imports and code from `src/index.ts`:
   - Remove the `import { ... } from './triage.js'` line
   - Remove `initTriage()` call from `main()`
   - Remove `setAlertSink(...)` block
   - Remove `handleBudgetCommand()` function
   - Remove `/budget` intercept in `onMessage`
   - Remove triage gate block in `processGroupMessages()`
3. Remove triage functions from `src/db.ts`:
   - Remove `triage_events` table creation from `createSchema()`
   - Remove `insertTriageEvent()`, `getTriageSpendSince()`, `pruneTriageEventsBefore()`
4. Delete `tickle-stick.yaml`
5. Uninstall: `npm uninstall tickle-stick`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
7. Optionally drop the audit table: `sqlite3 store/messages.db "DROP TABLE IF EXISTS triage_events"`
