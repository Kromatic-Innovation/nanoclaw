---
persona: drive-by-contributor
repo: Kromatic-Innovation/nanoclaw (PR target nanocoai/nanoclaw)
version: add-google-auth-2026-05-11
ref: 0fc8e13 (add-google-auth-upstream)
date: 2026-05-11
ttfs_minutes: 18
ttfs_outcome: partial
---

## Reviewer: Drive-by contributor

Time-to-first-success:      🟡 — README + CONTRIBUTING got me to a PR path in ~18 min, but no `.github/ISSUE_TEMPLATE/` means filing the bug first means writing a blank issue from scratch.
Public surface honesty:     🟡 — README install + Philosophy match what the diff does, but SKILL.md openly admits the `skill/add-google-auth` branch the install instructions tell users to merge doesn't exist yet ("pre-split state").
Versioning & changelog:     🔴 — root `package.json` is 2.0.56, CHANGELOG stops at 2.0.54, and this PR adds a brand-new MCP-tool surface with no CHANGELOG entry at all.
Maintenance signal:         🟢 — 855 open issues but `pushed_at` is today, 15 PRs in the last 24h with two drive-by PRs (#2410, #2408) merged today — this repo is alive.
Coherence of release:       🟡 — one-sentence pitch works ("shared OneCLI Google-auth foundation + two diagnostic MCP tools"), but SKILL.md cross-references five not-yet-existing skills (#52, #53, #55, `add-gmail-tool`, etc.) and a `feat/skill-patterns-v2-doc` branch, so the diff doesn't actually stand on its own.
Public-API & test coverage: 🟢 — both new exports `checkGoogleAuth` and `listGoogleScopes` have happy-path + 401/400 + thrown-error tests in `google-auth.test.ts`, and `bun test` is the documented command in `container/agent-runner/package.json`.

**Would you recommend this release ship?**
Only with edits

**Single most-important change that would move your verdict toward Yes:**
Resolve the `.claude/skills/add-google-auth/SKILL.md` "pre-split state" note before merging — either ship the `skill/add-google-auth` branch the SKILL tells users to `git merge`, or rewrite Phase 2 Step 1 to install from `main` directly. Right now the skill's own install instructions point at a branch that doesn't exist, which is the single thing that will make a drive-by user close the tab.

**Findings table:**

| Severity | File or surface | Finding | Suggested action |
|---|---|---|---|
| blocker | `.claude/skills/add-google-auth/SKILL.md` Phase 2 Step 1 | Tells the user to `git fetch origin skill/add-google-auth && git merge --no-ff origin/skill/add-google-auth`, then admits in a Note that this branch does not exist yet and the working branch is `feat/add-google-auth-v2`. A drive-by user copy-pasting the documented command gets a fetch error. | Either land the `skill/add-google-auth` branch as part of this PR, or rewrite the instruction to install from `main` post-merge and delete the pre-split note. |
| major | `CHANGELOG.md` | Latest entry is 2.0.54; `package.json` is already 2.0.56; this PR adds a new MCP-tool surface with no CHANGELOG line. As a contributor I can't tell if my PR is expected to add one. | Add a 2.0.55/2.0.56 stub or a CONTRIBUTING note clarifying that the `bump-version` workflow owns CHANGELOG — right now it's ambiguous. |
| major | `.github/ISSUE_TEMPLATE/` (absent) | Repo has 855 open issues but no issue templates. README's "report a bug" path is implicit. For a 2-minute bug filer this is the difference between firing off a report and closing the tab. | Add at least a minimal `bug_report.md` template; even a 3-field one would help. |
| major | SKILL.md "Credits & references" | Cross-references `docs/skill-patterns-v2.md` as available "on the `feat/skill-patterns-v2-doc` branch as of 2026-05-11", plus four planned `/add-<tool>` skills and three issue numbers (#50, #52, #53, #55). A reviewer on `nanocoai/nanoclaw` cannot verify any of these from the diff alone. | Either land the docs branch first, or scrub forward-references and link only to surfaces that exist on `main`. |
| minor | `container/agent-runner/src/mcp-tools/google-auth.ts` `probeTokeninfo` | Passes the literal `access_token=onecli-managed` query string and depends on the OneCLI gateway to rewrite it. If the gateway is misconfigured this leaks the placeholder into Google's request log. Not a security issue but it's an implicit contract not surfaced in the tool description. | Either send to a OneCLI-internal endpoint, or note in the JSDoc that the placeholder reaches Google when proxy is bypassed. |
| minor | `CONTRIBUTING.md` Testing section | One line: "Test your contribution on a fresh clone before submitting." Doesn't say `pnpm test` or `bun test` — you have to dig into `package.json` to find the commands the CI actually runs. | Add the two commands (`pnpm test` for host, `cd container/agent-runner && bun test` for container) verbatim, matching `.github/workflows/ci.yml`. |
| minor | `.github/PULL_REQUEST_TEMPLATE.md` | Template asks for a checkbox tick to drive label automation, but the diff for this PR doesn't show a filled-out template anywhere I can see (I only have the file diff). | Confirm the PR body uses the template — if not, the `PR: Skill` / `PR: Feature` label won't auto-apply. |
| minor | `LICENSE` | Copyright reads "2026 Gavriel" — single first name with no entity. As a drive-by I have to guess whether contributing means an implicit license-back to one person. No CLA is mentioned in CONTRIBUTING (which is fine, MIT is permissive), but the bare first name is a small smell. | Either expand to a real legal-name/entity or add one CONTRIBUTING line confirming "by opening a PR you license under the project's MIT terms." |
