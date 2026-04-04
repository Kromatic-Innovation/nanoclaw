---
name: add-github-issues
description: GitHub Issues list/create/update/comment. Adds host-side IPC handler and container MCP server for managing GitHub issues via the gh CLI.
---

# Add GitHub Issues Integration

This skill adds GitHub Issues support to NanoClaw as an IPC-based tool. The agent can list, create, update, and comment on GitHub issues across configured repositories.

## Prerequisites

- `gh` CLI installed and authenticated on the host (`gh auth status`)
- Or `GITHUB_TOKEN` environment variable set

## Phase 1: Pre-flight

### Check if already applied

Check if `src/github-issues-ipc.ts` exists. If it does, the code changes are already in place — skip to Phase 3 (Setup).

### Check gh CLI auth

```bash
gh auth status
```

If not authenticated, run `gh auth login`.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/github-issues
git merge origin/skill/github-issues
```

This merges in:

- `src/github-issues-ipc.ts` — Host-side IPC handler (watches `{group}/github-issues/requests/`, executes `gh` CLI commands)
- `container/agent-runner/src/github-issues-mcp-stdio.ts` — Container-side MCP server exposing Issues tools to the agent
- IPC wiring in `src/ipc.ts` and `src/container-runner.ts`
- MCP server registration in `container/agent-runner/src/index.ts`

### Validate code changes

```bash
npm install
npm run build
```

## Phase 3: Setup

### Configure repository mapping

The agent resolves repository references from `/workspace/global/repos.json` or falls back to `GITHUB_OWNER` / `GITHUB_REPO` environment variables. Each tool also accepts optional `owner` and `repo` parameters to override defaults.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test issue listing

```bash
gh issue list --repo <owner>/<repo> --limit 5
```

Once verified, tell the user:

> GitHub Issues is connected! You can now manage issues, e.g.:
>
> `List open issues in nanoclaw` or `Create an issue titled "Add feature X"`

## Troubleshooting

### gh CLI not found or not authenticated

```bash
gh auth status
gh auth login
```

### Permission denied on repository

Ensure the authenticated GitHub account has access to the target repository.

## Removal

1. Remove GitHub Issues IPC handler registration from `src/ipc.ts`
2. Remove GitHub Issues mount from `src/container-runner.ts`
3. Remove `container/agent-runner/src/github-issues-mcp-stdio.ts`
4. Remove `src/github-issues-ipc.ts`
5. Rebuild and restart
