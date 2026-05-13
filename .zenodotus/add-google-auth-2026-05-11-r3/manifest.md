# Zenodotus manifest — add-google-auth upstream contribution gate (round 3)

- **Repo:** Kromatic-Innovation/nanoclaw (fork of nanocoai/nanoclaw)
- **Ref:** `add-google-auth-upstream` (SHA `192c45e`)
- **Version label:** `add-google-auth-2026-05-11-r3`
- **Prior tag / upstream base:** `48dfb1b` (nanocoai/nanoclaw main HEAD)
- **Release diff scope:** `git diff 48dfb1b..192c45e`
- **Panel composition:** `drive-by-contributor` (single persona — same as r1, r2)
- **Date:** 2026-05-11
- **Round:** 3 of N (r1 verdict `conditional`, r2 verdict `conditional`)

## What changed since r2

One commit: `192c45e docs(add-google-auth): correct OneCLI CLI verbs + dashboard nav`. Three docs-drift fixes against live OneCLI 1.1.0 probe results (see fork issue #71 for transcript) plus the lone deferred r1 minor (probeTokeninfo JSDoc):

- Phase 1 Step 1: `onecli --version` → `onecli version` (the `--version` flag does not exist in OneCLI 1.1.0).
- Phase 1 Step 2: removed `onecli apps get --provider google` (no `apps` subcommand in OneCLI 1.1.0); replaced with `curl /api/connections | jq` probe.
- Phase 1 Step 2: dashboard nav rewritten from "Apps → Google → Connect" to "Connections → Google Calendar / Gmail / Drive / Sheets / Contacts → Connect" (per-service Connect tiles, not provider-level).
- `probeTokeninfo`: inline block comment upgraded to full JSDoc explaining the `access_token=onecli-managed` literal contract and cross-referencing SKILL.md Phase 3 Step 2.

Behavior unchanged. `tsc --noEmit` clean; `bun test src/mcp-tools/google-auth.test.ts` → 5 pass / 0 fail.

## r2 remaining findings carried forward (declared out of scope by human 2026-05-11)

| Severity | Finding | Status |
|---|---|---|
| major | `CHANGELOG.md` stops at 2.0.54, `package.json` is 2.0.56, no entry for this PR | Out of scope — `bump-version` workflow owns CHANGELOG. |
| major | MCP tools in trunk vs CONTRIBUTING's "trunk = bug/security/simplification only" | Out of scope — nanocoai-trunk-policy question, not adjudicable from this side. |
| minor | Missing `.github/ISSUE_TEMPLATE/`, README/SKILL length, PR template | Out of scope — nanocoai-trunk concerns. |

R3 should not re-litigate these. If they recur as 🔴/blocker, note in conflicts; verdict logic should treat them as previously-adjudicated rather than fresh signal.

## Diff summary

```
.claude/skills/add-google-auth/SKILL.md            | 31 +++++++++++++++-------
container/agent-runner/src/mcp-tools/google-auth.ts | 21 +++++++++++----
container/agent-runner/src/mcp-tools/google-auth.test.ts | 114 ++++++++  (from r1, unchanged)
container/agent-runner/src/mcp-tools/index.ts            |   1 +        (from r1, unchanged)
```

Cumulative r1→r3: 4 files, +534/-15 lines.

## Allowed / forbidden surface

Identical to r1 (`../add-google-auth-2026-05-11/manifest.md` §Allowed surface, §Forbidden surface).

## Reviewer output path

`.zenodotus/add-google-auth-2026-05-11-r3/reviews/drive-by-contributor.md`
