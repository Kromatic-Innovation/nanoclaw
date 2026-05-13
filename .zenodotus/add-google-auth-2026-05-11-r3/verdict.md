**Verdict: conditional** (round 3)

## Target

- Ref reviewed: `add-google-auth-upstream` @ `192c45e`
- Prior-tag/base: `48dfb1b`
- Round: 3 of N (r1 verdict `conditional`, r2 verdict `conditional`)

## Panel

| Persona              | TTFS (min) | Outcome   | Recommend?      |
| -------------------- | ---------- | --------- | --------------- |
| drive-by-contributor | 8          | success   | Only with edits |

## Rubric heatmap (r1 → r2 → r3)

| Dimension                  | r1       | r2      | r3      | Δ r2→r3 |
| -------------------------- | -------- | ------- | ------- | ------- |
| Time-to-first-success      | 🟡 (18m) | 🟢 (6m) | 🟢 (8m) | =       |
| Public surface honesty     | 🟡       | 🟡      | 🟡      | =       |
| Versioning & changelog     | 🔴       | 🔴      | 🟡      | ↑       |
| Maintenance signal         | 🟢       | 🟢      | 🟢      | =       |
| Coherence of release       | 🟡       | 🟡      | 🟢      | ↑       |
| Public-API & test coverage | 🟢       | 🟢      | 🟢      | =       |

Two improvements vs r2: Coherence rose to 🟢 (the JSDoc upgrade tightened the story); Versioning fell from 🔴 to 🟡 because the carried-forward CHANGELOG drift is the only remaining hit on that dimension and it is no longer a fresh blocker.

## r2 minor — RESOLVED

The `probeTokeninfo` literal `access_token=onecli-managed` JSDoc finding from r1 (deferred through r2) is closed in `192c45e`. r3 reviewer confirms: *"The expanded JSDoc on `probeTokeninfo` (L67-82 of google-auth.ts) now explains why `access_token=onecli-managed` is load-bearing — that closes the r2 minor about magic strings without comment."*

## r3 new findings — three minors, no blockers

| Severity | File / surface                                                              | Finding                                                                                                       | Recommended disposition                                                                                                  |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| minor    | `.claude/skills/add-google-auth/SKILL.md` L28                              | `onecli version` works on current OneCLI but no minimum-version note; older OneCLI fails silently             | **Single-line fix worth doing pre-PR:** add `# Requires OneCLI ≥ 1.1.0` adjacent to the command.                         |
| minor    | `.claude/skills/add-google-auth/SKILL.md` Phase 4                          | No verification step that rebuild actually picked up new MCP tools beyond `docker logs`                       | Add a `docker images \| grep nanoclaw-agent` timestamp check or a sentinel string the new build prints. Polish, not blocker. |
| minor    | `container/agent-runner/src/mcp-tools/google-auth.test.ts`                  | No test for the userinfo "200 but no email field" branch (L60-64 of `google-auth.ts` falls to `subject` then `(unknown)`) | Add one assertion exercising the `subject`-only fallback. Polish, not blocker.                                          |
| minor    | public-surface, `CONTRIBUTING.md` L126                                      | `CONTRIBUTING.md` directs contributors to "see PR Hygiene in CLAUDE.md"; `CLAUDE.md` is a private-feeling file | Either inline PR Hygiene into `CONTRIBUTING.md` or rename references to less LLM-specific filenames. Trunk-policy adjacent. |

## r2 findings carried forward (previously adjudicated, deferred)

| Origin | Finding | Disposition |
|---|---|---|
| r2 | CHANGELOG stops at 2.0.54, package.json 2.0.56, no entry for this PR | deferred — nanocoai-trunk `bump-version` workflow owns CHANGELOG |
| r2 | MCP-tools-in-trunk vs CONTRIBUTING "trunk = bug/security/simplification only" | deferred — nanocoai-trunk policy question |
| r2 | Missing `.github/ISSUE_TEMPLATE/` | deferred — nanocoai-trunk concern |

## Verdict rule applied

`conditional` triggered by: drive-by-contributor said "Only with edits" (not a clean recommend), and 2 🟡 in the panel. No 🔴, TTFS green, no fresh blockers.

This is the **softest conditional** we've seen across r1–r3 — every concrete finding is a one-line fix or a trunk-policy carry-forward. The reviewer's gut-feel verbatim:

> "Honestly? Yeah, I'd open a PR here. CONTRIBUTING.md tells me how to fork, branch, test, and label in under ten minutes — that's rare. The r3 commit visibly fixed the things I'd have caught in r2: bogus `onecli --version`, the fictional `onecli apps get`, and the unexplained `onecli-managed` placeholder. New surface (two MCP tools) has real tests with a clean fetch seam. My remaining gripes are minor — a missing OneCLI minimum-version note and one untested fallback branch. The carried-forward CHANGELOG/ISSUE_TEMPLATE stuff is trunk policy, not this PR's fight. Ship with the one-line version note."

## Recommended next action

**Two viable paths:**

1. **One-line fix → open PR.** Add `OneCLI ≥ 1.1.0` note to SKILL.md Phase 1 Step 1 in a `192c45e..193xxx` follow-up commit, then open the upstream PR. The remaining two minors (Phase 4 verification UX, userinfo-subject-fallback test) can be addressed in the PR review thread or as a follow-up PR. r4 zenodotus optional given the softness of r3 conditional.

2. **Open the PR on `192c45e` as-is** and surface all three minors in the PR description as known follow-ups. The drive-by-contributor reviewer explicitly said "Ship with the one-line version note" — interpreted strictly, this means option 1; interpreted as "ship it, just be honest about the gap", option 2 is acceptable.

Either way, the trunk-policy carry-forwards from r2 are not adjudicable from the contribution side and should be flagged in the PR body as such.

## Files

- `.zenodotus/add-google-auth-2026-05-11/` — r1 manifest, review, verdict
- `.zenodotus/add-google-auth-2026-05-11-r2/` — r2 manifest, review, verdict
- `.zenodotus/add-google-auth-2026-05-11-r3/` — r3 manifest, review, verdict (this file)
