# MoSCoW Prioritization Framework

Canonical reference for all skills and agents. When any skill needs MoSCoW
definitions, reference this file rather than embedding inline definitions.

## Labels

Use exactly one label per issue or finding: `moscow:must`, `moscow:should`,
`moscow:could`, `moscow:wont`.

Default to `moscow:should` for ordinary feature/bug work unless a stronger
signal exists.

## Definitions

### Must

**The system is broken, blocked, or non-compliant without this.**

Do this now. Schedule immediately.

Examples:
- A critical bug that kills a worker, OOMs the app, or stops a needed feature
- A critical security vulnerability (active exploit risk, credential exposure)
- A compliance or legal obligation (GDPR breach, accessibility mandate)
- A contractual commitment with a hard deadline
- A blocker for other Must or Should items

Not-Must: something feels urgent because someone is asking loudly. Must means
"we cannot operate without this," not "someone wants it fast."

### Should

**Delivers ROI or meaningfully improves the customer experience. A workaround
exists but the current state causes friction.**

Important but not blocking. Schedule this cycle.

Examples:
- A bug that lowers retention or causes user friction but doesn't block the flow
- A feature that improves the UI or removes a manual workaround
- A revenue-impacting improvement where the business still functions without it
- A QA finding that Dijkstra can fix in-PR if low-effort, otherwise tracked as
  follow-up

The key distinction from Must: the user can still complete their goal, just with
more friction or a worse experience.

### Could

**Nice to have. We want it, but only after the Musts and Shoulds.**

Do if time permits after higher-priority work is complete.

Examples:
- An admin-only feature that makes internal life easier
- A refactor that improves code quality but doesn't change behavior
- Developer experience or internal tooling improvements
- A QA finding logged as follow-up that doesn't block merge

### Won't

**Will not do now. May revisit in the future.**

Not doing this in the current cycle. Record the rationale. Reclassify when all
Must/Should/Could items in the cycle are resolved, or when new evidence changes
the priority.

Examples:
- Breaking dependency upgrades that aren't high-security but represent tech debt
- Features with no validated demand
- Large-effort items where the ROI case isn't proven
- Speculative features without user evidence

Won't does not mean "never." It means "not now, and here's why."

## Sequencing Within a Bucket

When multiple items share the same MoSCoW label, sequence by:

1. **Dependency-ordered** — if it unblocks other items, do it first. Multi-repo
   coordination is a signal of dependencies (and higher integration risk).
2. **Risk-weighted** — higher uncertainty or higher blast radius goes before
   safer items. Learn what could go wrong early.
3. **Single-repo before multi-repo** — when neither dependency nor risk
   differentiates, knock off contained items first. They're less likely to stall
   and free up attention for the coordinated work.

## QA Triage Application

When Occam classifies Quine's findings:

| Label | Action |
|-------|--------|
| `moscow:must` | Blocks merge. Dijkstra fixes before PR merges. |
| `moscow:should` | Dijkstra fixes in this PR if low-effort, otherwise tracked as follow-up issue. |
| `moscow:could` | Logged as follow-up issue. Does not block merge. |
| `moscow:wont` | Acknowledged and dismissed with rationale. |

## Human Gate

MoSCoW labels on recommendations (as opposed to QA findings or implementation
issues) require human review. No recommendation ships without a human-assigned
MoSCoW label. See the marketing-audit-orchestrator skill for the full gate
protocol.
