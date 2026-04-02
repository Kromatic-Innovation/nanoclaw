---
name: add-sheets
description: Google Sheets read/write/append plus contact database. Adds host-side IPC handler and container MCP server for spreadsheet operations via Google Sheets API.
---

# Add Google Sheets Integration

This skill adds Google Sheets support to NanoClaw as an IPC-based tool. The agent can create, read, write, and append to spreadsheets, and use a dedicated contact database backed by a Google Sheet.

## Prerequisites

- `skill/google-auth` must be applied first (shared Google OAuth credentials)

## Phase 1: Pre-flight

### Check if already applied

Check if `src/sheets-ipc.ts` exists. If it does, the code changes are already in place — skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/sheets
git merge origin/skill/sheets
```

This merges in:

- `scripts/google_sheets_wrapper.py` — Python wrapper for Google Sheets API (create, read, write, append, list-sheets, add-sheet)
- `scripts/sheets_contact_db.py` — Contact database layer backed by a Google Sheet
- `src/sheets-ipc.ts` — Host-side IPC handler (watches `{group}/sheets/requests/`)
- `container/agent-runner/src/sheets-mcp-stdio.ts` — Container-side MCP server exposing Sheets tools to the agent
- IPC wiring in `src/ipc.ts` and `src/container-runner.ts`
- MCP server registration in `container/agent-runner/src/index.ts`

### Validate code changes

```bash
npm install
npm run build
```

## Phase 3: Setup

Google Sheets uses the same OAuth credentials as Gmail/Calendar. If those are already configured, no additional setup is needed.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test spreadsheet operations

```bash
python3 scripts/google_sheets_wrapper.py create --title "Test Sheet"
python3 scripts/google_sheets_wrapper.py read --spreadsheet-id <ID> --range "Sheet1!A1:C10"
```

### Test contact database

```bash
python3 scripts/sheets_contact_db.py --help
```

Once verified, tell the user:

> Google Sheets is connected! You can now create, read, and write spreadsheets, e.g.:
>
> `Create a spreadsheet called "Weekly Report" with columns Name, Score, Date`

## Troubleshooting

### Sheets wrapper not responding

Test the wrapper directly:

```bash
python3 scripts/google_sheets_wrapper.py list-sheets --spreadsheet-id <ID>
```

### OAuth credentials missing

Sheets uses the same Google OAuth credentials as Gmail/Calendar. Ensure `skill/google-auth` has been applied and credentials are configured.

## Removal

1. Remove Sheets IPC handler registration from `src/ipc.ts`
2. Remove Sheets mount from `src/container-runner.ts`
3. Remove `container/agent-runner/src/sheets-mcp-stdio.ts`
4. Remove `src/sheets-ipc.ts`
5. Remove `scripts/google_sheets_wrapper.py`
6. Remove `scripts/sheets_contact_db.py`
7. Rebuild and restart
