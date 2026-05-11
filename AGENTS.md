# NanoClaw — Agent Policy

## GitHub

- **Owner:** Kromatic-Innovation (this fork)
- **Repo:** nanoclaw
- **Upstream:** [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw) (formerly `qwibitai/nanoclaw`; renamed 2026-05-11)

This repo is the Kromatic-Innovation fork of NanoClaw. Skill updates and
feature work originate here; selected changes flow upstream to
`nanocoai/nanoclaw` via PR.

## Branch policy

**`main` is a clean mirror of `nanocoai/nanoclaw` upstream.** Nothing
originated in this fork ever lands on `main`. Branches ARE the deliverable
for Kromatic-authored work — they live on the fork forever, never merge
into `main` or anywhere else here.

Ruleset on `main` (ID 14696793, active):

- `deletion` — block branch deletion
- `non_fast_forward` — block force-push
- `required_linear_history` — block merge commits
- `pull_request` required, 0 approvals, **only `rebase` merge method
  allowed** — so PR-merging is effectively fast-forward

**The only PRs allowed against `main`** are upstream syncs from a
`sync/upstream-main-*` branch that contains exactly the upstream HEAD
(zero divergence). Any PR to `main` that adds fork-only commits must be
rejected — it would break the mirror.

### Branch naming convention

| Pattern                         | Purpose                                                                                                            | Lifespan                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `feat/<name>-v2`                | Work-in-progress port or new development                                                                           | Until ready, then renamed          |
| `<name>-upstream`               | PR source branch targeting `nanocoai/nanoclaw`; contains exactly one feature + its SKILL.md (if any)               | Until upstream PR merges or closes |
| `skill/<name>`                  | Fork-only install target for a skill; downstream consumers (voltaire etc.) pull from this branch via `/add-<name>` | Permanent on fork                  |
| `kromatic-fork/<name>`          | Fork-only durable docs/config that we will never PR upstream                                                       | Permanent on fork                  |
| `sync/upstream-main-YYYY-MM-DD` | Upstream sync candidate; PR'd to `main` then deleted                                                               | Single-use                         |
| `legacy-v1/<name>`              | Frozen v1 snapshots — do not touch                                                                                 | Permanent reference                |

### Where this AGENTS.md lives

Since `main` mirrors upstream strictly, this file cannot live on `main`.
It lives on the **`kromatic-fork/agents-md`** branch as durable fork-only
policy. Agents working in this repo should fetch and read it from there,
or rely on the workspace-level guidance in
`$WORKSPACE/.claude/skills/contribute-to-nanoclaw/SKILL.md` (which
re-states the same policy).

## Three-tier pull-down chain (REQUIRED reading)

NanoClaw flows down through three repos, each layer a fast-forward
mirror of the layer above:

```
nanocoai/nanoclaw:main                  (upstream — the public project)
        │  FF only via sync/upstream-main-* PRs
        ▼
Kromatic-Innovation/nanoclaw:main       (this fork — strict mirror)
        │  FF only via sync (Voltaire's `nanoclaw` remote points here)
        ▼
TriKro/voltaire:upstream                (Voltaire's nanoclaw-tracking branch)
        │  merged into develop after personal-customization rebase
        ▼
TriKro/voltaire:develop                 (Voltaire — where personal customization lives)
```

**Implications for every contribution on this fork:**

1. **Upstream conventions are non-negotiable.** Skills, channels, and
   plugins authored here must look indistinguishable from upstream's
   own. No Voltaire-specific references in `<name>-upstream` or
   `skill/<name>` branches — those branches feed both upstream and
   Voltaire and must work for users who have never heard of Voltaire.
2. **Personal customization lives in Voltaire, not in this fork.** Any
   tweak that makes sense only for Tristan's install belongs in
   `TriKro/voltaire:develop`, never in any branch of this fork.
3. **Build each skill/channel/plugin on its own branch and keep it
   independently mergeable.** Voltaire pulls them in via the `/add-<name>`
   install flow (`git fetch nanoclaw skill/<name> && git merge ...`). If
   your branch carries unrelated commits, that merge becomes painful.
4. **When upstream changes need to flow down**, the path is: upstream PR
   merges → fork `sync/upstream-main-YYYY-MM-DD` PR merges → Voltaire
   `upstream` branch fast-forwards from fork `main` → Voltaire `develop`
   rebases on `upstream` (or starts over if the rebase is destructive).
   Keeping each layer FF-only keeps this tractable; merge commits in the
   middle break it.

This is why **fork `main` is FF-only**: every additional commit on fork
`main` becomes a divergence Voltaire's `upstream` branch would have to
handle. Branches are the deliverable; main is the pipe.

## Pre-upstream-PR review gate

Before opening any PR from this fork to `nanocoai/nanoclaw`, run the
workspace `/zenodotus` skill against the change scope:

```
/zenodotus --repo . --ref <feature-branch> --version <target-version> \
  --prior-tag <upstream-base> --personas drive-by-contributor
```

The **drive-by-contributor** persona is the critical lens here: the
upstream maintainer will read your PR as a stranger. Run that persona
specifically. Add `production-evaluator` and `maintainers-maintainer` for
broader skill releases.

Zenodotus reviewers operate under **no-context isolation** — they see only
the public surface (README, CHANGELOG, CONTRIBUTING, public API, tests,
release diff) and **nothing else**. No `AGENTS.md`, no `CLAUDE.md`, no
`.claude/`, no internal docs, no commit history outside the diff window.
This mirrors what the upstream maintainer sees.

Verdict gates the PR:

- **Pass** → open the upstream PR using the drafted summary from
  `.zenodotus/<version>/tag-message.md` as the PR body.
- **Conditional** / **Fail** → fix the must-fix items on the feature
  branch, re-run `/zenodotus`, retry.

Zenodotus is **additive** to internal review, not a substitute. Workspace
PR [Kromatic-Innovation/code-workspace-config#264](https://github.com/Kromatic-Innovation/code-workspace-config/pull/264)
tracks the skill itself; issue
[Kromatic-Innovation/code-workspace-config#234](https://github.com/Kromatic-Innovation/code-workspace-config/issues/234)
captures the policy rationale.

The `.zenodotus/` directory is gitignored — verdict artifacts are local
record, not durable repo state.

## Related workspace skills

- `/zenodotus` — the no-context review gate above
- `/contribute-to-nanoclaw` — the upstream PR convention (branch shape,
  SKILL.md format, downstream-patches-local rule)

## Repo conventions

See `CLAUDE.md` for the durable architectural notes (orchestrator, channel
registry, IPC, OneCLI secrets, container layout). This file (`AGENTS.md`)
covers process policy only.
