---
persona: drive-by-contributor
repo: Kromatic-Innovation/nanoclaw
version: add-google-auth-2026-05-11-r3
ref: 192c45e
date: 2026-05-11
ttfs_minutes: 8
ttfs_outcome: success
---

## Reviewer: Drive-by Contributor

Time-to-first-success:      🟢 — README + CONTRIBUTING.md at repo root, PR template present, branch policy obvious — ~8 minutes to know where a fix PR goes.
Public surface honesty:     🟡 — SKILL.md `Phase 4` references `systemctl --user restart nanoclaw` and `launchctl kickstart` matching CLAUDE.md dev docs, but I can't independently verify `onecli version` from public material — I'm trusting it landed.
Versioning & changelog:     🟡 — Diff is contained (4 files, +522/-15), but no CHANGELOG entry for the new MCP tools or skill (carried-forward from r2, deferred).
Maintenance signal:         🟢 — CONTRIBUTING.md is concrete (fork, branch, test, PR template with label-mapping table), PULL_REQUEST_TEMPLATE.md exists — feels like an active project.
Coherence of release:       🟢 — One thesis: install foundation skill + two diagnostic MCP tools. SKILL.md + tool + test + barrel import all serve that single story.
Public-API & test coverage: 🟢 — Both `check_google_auth` and `list_google_scopes` have happy-path + failure-mode tests (`google-auth.test.ts` L40-114); fetch is injected via `__setFetchForTesting`, no globalThis monkey-patching.

**Would you recommend this release ship?**
Only with edits

**Single most-important change that would move your verdict toward Yes:**
Add a short note in `SKILL.md` Phase 1 Step 1 that `onecli version` (no `--`) is the correct subcommand on OneCLI ≥ some-version — when I copy-paste that command and it fails, my next move is to close the tab. One line listing the minimum OneCLI version this skill targets would seal the deal.

**Round-3-specific signal (what changed since r2):**
The docs-drift fixes landed cleanly: `onecli --version` → `onecli version`, the Apps→Google UI walk-through is replaced with the actual Connections dashboard flow, and `onecli apps get` is replaced with a real `curl /api/connections | jq` verifier. The expanded JSDoc on `probeTokeninfo` (L67-82 of `google-auth.ts`) now explains *why* `access_token=onecli-managed` is load-bearing — that closes the r2 minor about magic strings without comment.

**Findings table:**

| Severity | File or surface | Finding | Suggested action |
|---|---|---|---|
| minor | `.claude/skills/add-google-auth/SKILL.md` L28 | `onecli version` command works on current OneCLI but no minimum version is documented; if a contributor has an older OneCLI it fails silently with a usage banner. | Add `# OneCLI >= X.Y.Z required` adjacent to the command. |
| minor | `.claude/skills/add-google-auth/SKILL.md` L156-161 | Phase 4 lists `pnpm run build && ./container/build.sh` then a `systemctl`/`launchctl` step but no verification that the rebuild actually picked up the new MCP tools beyond "check `docker logs`" — easy to miss-rebuild. | Add a `docker images | grep nanoclaw-agent` timestamp check, or a sentinel string the new build prints. |
| minor | `container/agent-runner/src/mcp-tools/google-auth.test.ts` | No test for the userinfo "200 but no email field" branch (L60-64 of `google-auth.ts` falls through to `subject` and then `(unknown)`). | Add one assertion that exercises the `subject`-only fallback path. |
| minor | public surface | The harness auto-injected `CLAUDE.md` and `container/CLAUDE.md` into my context as system reminders. As a true drive-by I shouldn't have those, and a real contributor reading the repo on github.com gets them as just two more markdown files. This isn't a release blocker but flags that the *contributor* path leans heavily on CLAUDE.md, which `CONTRIBUTING.md` L126 explicitly tells contributors to consult ("see PR Hygiene in CLAUDE.md") — that's a private-feeling file with a public-facing role. | Either inline the PR Hygiene section into `CONTRIBUTING.md` or rename `CLAUDE.md` to something less LLM-specific in the contributor-facing references. |

**Carried-forward (previously adjudicated, not scored):**

| Origin round | Finding | Disposition |
|---|---|---|
| r2 | CHANGELOG drift (stops at 2.0.54, package.json is 2.0.56) | deferred — nanocoai-trunk policy (bump-version workflow owns CHANGELOG) |
| r2 | MCP-tools-in-trunk vs CONTRIBUTING's "trunk = bug/security/simplification only" framing | deferred — nanocoai-trunk policy |
| r2 | Missing `.github/ISSUE_TEMPLATE/` directory | deferred — nanocoai-trunk policy |
