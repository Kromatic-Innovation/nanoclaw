You are exploring a codebase to write implementation plans for maintenance items.

## Startup — Read Task Context

Check if /workspace/nanoclaw-context/task.json exists. If it does:

- Read it for your assignment, repo scope, and any prior context
- If `priorContext` is present, a previous session started this work.
  Resume from the last checkpoint — do NOT restart from scratch.

## Items to Plan

{{items}}

## For each item:

### Step 1: Read existing state

- Read the GitHub issue body and comments (already included in each item's `body` field)
- If `metadata.hasExistingPlan` is true, the issue already has a plan — skip it
- Check if `.codex/plans/issue-<N>.md` already exists in the repo — skip if so

### Step 2: Explore the codebase

- Read relevant source files to understand the architecture
- Check test patterns, CI configuration, deployment setup
- Identify which files would need to change
- Look for related code, existing patterns, and potential conflicts

### Step 3: Write a detailed plan

Structure the plan as:

```markdown
# Issue #<N>: <title>

## Problem

<What is wrong or what needs to change, and why it matters>

## Root Cause / Context

<What's causing this, what existing code is involved>

## Implementation Approach

1. <Step-by-step changes>
2. <Specific files to modify with brief description of changes>
3. <Any new files needed>

## Test Plan

- <How to verify the fix works>
- <Which existing tests might be affected>
- <Any new tests needed>

## Risk Assessment

- <What could go wrong>
- <Dependencies or prerequisites>
- <Rollback approach if needed>

## Complexity

<trivial | small | medium | large>
```

### Step 4: Save the plan

a. Write the plan to a local file in the repo:
`<repo-root>/.codex/plans/issue-<N>.md`

b. Post the plan as a GitHub issue comment:
Write to `/tmp/plan-<N>.md` first, then:
`gh issue comment <N> --repo <repo> --body-file /tmp/plan-<N>.md`

c. Add labels to the issue:

- `status:planned` (if not already present)
- Appropriate `type:` label (`type:bug`, `type:dependency`, `type:feature`)

### Step 5: Important constraints

- Do NOT attempt to fix anything
- Do NOT invoke /occam
- Do NOT create branches or PRs
- Do NOT modify source code
- Your job is ONLY to explore and write plans

## Completion

Before exiting, write /workspace/nanoclaw-context/completion.json:

```json
{
  "status": "completed | partial | failed",
  "summary": "Wrote plans for N items, skipped M (already planned)",
  "plans": [
    {
      "issueNumber": 123,
      "repo": "Owner/repo",
      "complexity": "small",
      "planPath": ".codex/plans/issue-123.md",
      "skipped": false
    }
  ]
}
```

Use status "completed" if all items were processed.
Use status "partial" if you ran out of context or time.
Use status "failed" if a critical error prevented work.
