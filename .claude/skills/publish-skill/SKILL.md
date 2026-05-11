---
name: publish-skill
description: Squash-merge a voltaire:skill/* branch and push it to Kromatic-Innovation/nanoclaw as a PR-ready skill branch.
---

# About

Publishes a skill from voltaire to the public fork (`Kromatic-Innovation/nanoclaw`)
so it can be PR'd to `qwibitai/nanoclaw`. The fork's `skill/<name>` branch ends up
as `nanoclaw/main` + one squashed commit — clean, minimal, and ready for review.

Run `/publish-skill <name>` in Claude Code (from the voltaire repo).

## How it works

1. Validates the `voltaire:skill/<name>` branch descends from `voltaire:upstream`.
2. Squash-merges the branch onto a temporary ref based on `nanoclaw/main`.
3. Force-pushes the result to `Kromatic-Innovation/nanoclaw:skill/<name>`.
4. Cleans up the temporary ref.

The fork's `skill/<name>` branch is always exactly `nanoclaw/main` + one commit.
Re-running after updates to the voltaire branch replaces the fork branch with a
fresh squash.

## When to use

- Before opening a PR from `Kromatic-Innovation/nanoclaw:skill/<name>` → `qwibitai/nanoclaw`
- After updating a voltaire skill branch in response to PR review feedback
- Any time the fork's copy needs to reflect the latest state of `voltaire:skill/<name>`

## When NOT to use

- For private skills that should never reach the fork
- For branches not created from `voltaire:upstream` (they may contain private content)

---

# Goal

Safely publish a voltaire skill branch to the public fork as a single squashed
commit, ready for an upstream PR.

# Operating principles

- Never publish a branch that doesn't descend from `voltaire:upstream`.
- Never publish content from `voltaire:develop` or `voltaire:main`.
- Always squash — the fork branch must be `nanoclaw/main` + minimal commits.
- Always use `--force-with-lease`, never `--force`.
- Keep token usage low: only git operations, no file scanning.

# Step 0: Preflight

Parse the skill name from the argument. If no argument given, ask the user.

Run:

- `git status --porcelain`
  If non-empty: tell user to commit or stash, stop.

Verify remotes:

- `git remote -v`
  Confirm `nanoclaw` points to `Kromatic-Innovation/nanoclaw`.
  Confirm `origin` points to `TriKro/voltaire`.

Verify the source branch exists:

- `git rev-parse --verify skill/<name>` — if missing, stop with error.

Fetch latest:

- `git fetch nanoclaw --prune`
- `git fetch origin upstream --prune`

# Step 1: Validate ancestry

The skill branch MUST descend from `origin/upstream`. This ensures no private
content from `develop` or `main` leaks to the fork.

- `UPSTREAM_SHA=$(git rev-parse origin/upstream)`
- `git merge-base --is-ancestor $UPSTREAM_SHA skill/<name>`

If this fails:

- Tell user: "skill/<name> does not descend from origin/upstream. It may
  contain private content and cannot be published. Create the branch from
  upstream first."
- Stop.

# Step 2: Check for private content

As a safety net, check if any files that should never reach the fork are
modified in this branch:

- `git diff --name-only origin/upstream...skill/<name>`

Flag files matching:

- `groups/` (per-group memory)
- `config/` or `.env` (installation config)
- `AGENTS.md` (installation policy)

If any flagged files found:

- Show the list and warn: "These files are voltaire-specific and should not
  be published to the fork."
- Ask user to confirm or abort.

# Step 3: Squash-merge onto nanoclaw/main

Create a temporary detached branch from `nanoclaw/main`:

- `git checkout -B _publish nanoclaw/main`

Squash-merge the skill branch:

- `git merge --squash skill/<name>`

If conflicts:

- Show conflicted files.
- These typically mean the skill branch has drifted from upstream. Ask user
  whether to resolve or abort.
- If resolving: open only conflicted files, resolve markers, `git add`.

Commit with a descriptive message:

- `git commit -m "skill/<name>: <summary>"`
- The summary should describe what the skill adds (e.g., "add Sentry IPC integration").
- If the fork already had this branch, reuse the previous commit message where appropriate.

# Step 4: Push to fork

- `git push nanoclaw _publish:skill/<name> --force-with-lease`

If the push is rejected (non-fast-forward and lease fails):

- This means someone else updated the fork branch. Show the error and ask
  the user whether to force-push or abort.

# Step 5: Cleanup

- `git checkout develop`
- `git branch -D _publish`

# Step 6: Summary

Show:

- Published: `voltaire:skill/<name>` → `Kromatic-Innovation/nanoclaw:skill/<name>`
- Fork branch SHA: `git ls-remote nanoclaw refs/heads/skill/<name>`
- Voltaire branch SHA: `git rev-parse skill/<name>`

If a PR already exists from this branch:

- `gh pr list --repo qwibitai/nanoclaw --head skill/<name> --state open`
- If found, show the PR URL. Suggest the user check if the PR description
  needs updating.
- If not found, ask if the user wants to open a PR now.
