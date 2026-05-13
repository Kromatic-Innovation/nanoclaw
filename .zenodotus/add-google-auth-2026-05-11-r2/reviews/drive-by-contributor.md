---
persona: drive-by-contributor
repo: Kromatic-Innovation/nanoclaw (PR target nanocoai/nanoclaw)
version: add-google-auth-2026-05-11-r2
ref: 5a80b8f (add-google-auth-upstream)
date: 2026-05-11
ttfs_minutes: 6
ttfs_outcome: success
---

## Reviewer: Drive-by contributor

Time-to-first-success: 🟢 — README links Discord + repo, CONTRIBUTING.md tells me to `gh pr list/issue list` and use the PR template; I'd be filing in ~6 min.
Public surface honesty: 🟡 — README still says "channels live on a long-lived `channels` branch" and trunk ships no Google integration, but this PR plants two diagnostic MCP tools into trunk's `container/agent-runner/src/mcp-tools/index.ts` without a README/CHANGELOG mention.
Versioning & changelog: 🔴 — `package.json` says `2.0.56` but `CHANGELOG.md` stops at `2.0.54` (2026-05-10) and has no entry for this skill or the new MCP tools — a drive-by reading the changelog cannot tell this shipped.
Maintenance signal: 🟢 — upstream pushed 9h ago, 14+ PRs merged in the last 48h from many different contributors, issues triaged with labels.
Coherence of release: 🟡 — "shared Google OAuth foundation skill + two diagnostic MCP tools" is one story, but the diagnostic tools landing in trunk while CONTRIBUTING.md says "don't add features to trunk — add skills" is a tension reviewers will flag.
Public-API & test coverage: 🟢 — both new exports (`checkGoogleAuth`, `listGoogleScopes`) have happy-path + error-path tests in `google-auth.test.ts` using a `__setFetchForTesting` seam; `bun test` per `container/agent-runner/package.json`.

**Would you recommend this release ship?**
Only with edits

**Single most-important change that would move your verdict toward Yes:**
Add a `## [2.0.56]` (or next) entry to `CHANGELOG.md` naming the `/add-google-auth` skill and the two new MCP tools, and add one line to README's "What It Supports" or to CONTRIBUTING to explain why these two diagnostic tools live in trunk instead of behind a skill branch — without that, the PR contradicts the project's own "skills over features" rule on its face.

**Findings table:**

| Severity | File or surface                                                   | Finding                                                                                                                                                                                                                                            | Suggested action                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| major    | `CHANGELOG.md`                                                    | Top entry is 2.0.54 but `package.json` is at 2.0.56; no mention of `add-google-auth` skill or new `check_google_auth` / `list_google_scopes` MCP tools                                                                                             | Add a changelog entry for the version this PR will ship under, listing the skill and the two diagnostic tools                                                                                    |
| major    | `container/agent-runner/src/mcp-tools/index.ts` + CONTRIBUTING.md | CONTRIBUTING says trunk source changes are only bug/security/simplification — features go in skills; this PR adds two new MCP tools to trunk's barrel as part of a feature skill                                                                   | Either justify the trunk addition in PR body and update CONTRIBUTING to carve out "diagnostic tools shared across Google skills", or move the tools onto the skill branch alongside the SKILL.md |
| minor    | `.github/ISSUE_TEMPLATE/`                                         | Directory does not exist on the branch — public surface incomplete; new issue page is freeform only, raising the bar to file a bug report                                                                                                          | Add a minimal bug-report + feature-request template (separate PR is fine)                                                                                                                        |
| minor    | `.github/PULL_REQUEST_TEMPLATE.md`                                | PR checkbox list has "Feature skill / Utility skill / Operational skill / Fix / Simplification / Documentation" — this PR is both a feature skill (SKILL.md + skill branch) and a source change (MCP tools in trunk); template forces a single box | Note in PR description which box was checked and why; consider a "Skill + diagnostic" combined option for foundation skills                                                                      |
| minor    | `README.md` "What It Supports"                                    | Lists Gmail/Calendar/Sheets/Contacts only implicitly under "Multi-channel messaging" + `/add-<channel>` skills; no mention that there is now a shared `/add-google-auth` foundation step                                                           | Add one bullet or a parenthetical noting the foundation skill exists                                                                                                                             |
| minor    | `.claude/skills/add-google-auth/SKILL.md`                         | SKILL.md is 8.7KB / ~250 lines per CONTRIBUTING.md's "under 500 lines" rule — within limit but on the heavy side for what's framed as a prerequisite skill                                                                                         | Consider splitting reference material (scope catalogue, troubleshooting) into a sibling `.md` referenced from SKILL.md                                                                           |
