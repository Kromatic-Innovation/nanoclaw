# Zenodotus manifest — add-google-auth upstream contribution gate

- **Repo:** Kromatic-Innovation/nanoclaw (fork of nanocoai/nanoclaw)
- **Ref:** `add-google-auth-upstream` (SHA `0fc8e13`)
- **Version label:** `add-google-auth-2026-05-11`
- **Prior tag / upstream base:** `48dfb1b` (nanocoai/nanoclaw main HEAD)
- **Release diff scope:** `git diff 48dfb1b..0fc8e13`
- **Panel composition:** `drive-by-contributor` (single persona — this is a
  contributor-attraction gate, not a release-readiness gate; we are
  asking whether a stranger filing an upstream PR for this skill would
  succeed inside the project's contribution flow)
- **Date:** 2026-05-11

## Release diff summary

```
.claude/skills/add-google-auth/SKILL.md            | 248 +++++++++++++++
 container/agent-runner/src/mcp-tools/google-auth.test.ts | 114 ++++++++
 container/agent-runner/src/mcp-tools/google-auth.ts      | 149 +++++++++
 container/agent-runner/src/mcp-tools/index.ts            |   1 +
 4 files changed, 512 insertions(+)
```

## Allowed surface (reviewer may read)

- `README.md`, `README_ja.md`, `README_zh.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `LICENSE`
- Issue templates: `.github/ISSUE_TEMPLATE/` (if present)
- PR template: `.github/PULL_REQUEST_TEMPLATE.md` (if present)
- Top-level `package.json` and `container/agent-runner/package.json`
- Release diff: `git diff 48dfb1b..add-google-auth-upstream`
- The added files themselves:
  - `.claude/skills/add-google-auth/SKILL.md`
  - `container/agent-runner/src/mcp-tools/google-auth.ts`
  - `container/agent-runner/src/mcp-tools/google-auth.test.ts`
  - `container/agent-runner/src/mcp-tools/index.ts` (diff only)
- Public GitHub surface as a stranger would see it:
  - https://github.com/nanocoai/nanoclaw — upstream project, issue tracker, PR list, recent contributor PRs
- `tests/` and `container/agent-runner/src/` to understand how to run the new tests

## Forbidden surface (reviewer MUST NOT read)

- `AGENTS.md` (any level)
- `CLAUDE.md` (any level)
- `.claude/skills/` _other than_ the one under review
  (`.claude/skills/add-google-auth/`)
- `~/knowledge/` and any memory files
- Orchestrator plans, internal `docs/` not part of the public README path
- Commit history beyond `48dfb1b..add-google-auth-upstream`
- The fork's `kromatic-fork/agents-md` branch
- Voltaire repo or any downstream consumer

If the reviewer wants more context, that is a finding ("public surface
is incomplete here") — not an excuse to read internal material.

## Reviewer output path

`.zenodotus/add-google-auth-2026-05-11/reviews/drive-by-contributor.md`
