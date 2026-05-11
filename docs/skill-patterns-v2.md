# Skill patterns for NanoClaw v2 — API skills

Canonical reference for authoring skills that call external HTTPS APIs in NanoClaw v2. Reference doc, not a tutorial — for the broader skill taxonomy (feature/utility/operational/container) see [CONTRIBUTING.md](../CONTRIBUTING.md). For the v1→v2 architecture diff see [v1-to-v2-changes.md](v1-to-v2-changes.md).

If your skill _talks to an external API_, this doc applies.

---

## The architectural rule

**API skills run inside the agent container. The host has no role.**

- No host-side adapter file, no native Node module wired into `src/`.
- No environment variable on the host process holding the API key.
- No IPC bridge, no file watcher, no stdin piping between host and container.
- The host's only job for an API skill is to forward inbound messages to the container's `inbound.db`. That is already done — you do not touch it.

This rule exists because v2 is built on a hard host/container split (see `CLAUDE.md` → "Two-DB Session Split"). The host runs Node + pnpm; the container runs Bun. They share no modules. The two session DBs are the entire IO surface between them. Reaching across that line creates the v1-style monolith we deliberately broke apart.

If the skill needs a chat-platform adapter (Discord, Slack, etc.) rather than an outbound API, it is a **channel install skill** instead — see [skills-as-branches.md](skills-as-branches.md). Different pattern; do not mix the two.

---

## OneCLI credential pattern

Credentials live in the [OneCLI Agent Vault](https://github.com/onecli) — a local service at `http://127.0.0.1:10254` that holds secrets and injects them into approved outbound requests as they leave the container. **The container never sees the raw secret value.**

### How requests authenticate

1. The agent makes an HTTPS request to `api.example.com`.
2. The request goes through the container's HTTP proxy → OneCLI gateway.
3. The gateway matches the request's host pattern against vault secrets scoped to this agent.
4. Match found → gateway injects the auth header (`Authorization: Bearer …`, `X-API-Key: …`, etc.) and forwards.
5. The agent's code only ever sees the response.

The agent does not call the vault directly and does not handle the secret. It just makes a normal HTTPS request and trusts the proxy.

### Scoping a secret to an agent

Auto-created agents start in **`selective` secret mode** (`container-runner.ts:385` → `onecli.ensureAgent`). No secrets are attached even if the vault has a matching host pattern. This is the most common "401 from a configured API" symptom.

Two fixes, by preference:

```bash
# Preferred: flip the agent to "all" — every vault secret with a matching
# host pattern gets injected on demand.
onecli agents set-secret-mode --id <agent-id> --mode all

# Tighter: stay selective and assign specific secrets by id.
onecli secrets list                                       # find secret ids
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>
```

Find the agent id with `onecli agents list` (the `identifier` is the agent group id). Inspect what is currently assigned with `onecli agents secrets --id <agent-id>`.

No container restart is needed — the gateway resolves secrets per request, so the next outbound call picks up the new assignment.

### Adding a new secret

```bash
onecli secrets create \
  --name "Example API" \
  --host-pattern "api.example.com" \
  --header "Authorization: Bearer ${EXAMPLE_API_KEY}"
```

Host patterns are matched against request hostnames. Header value can reference an env var that OneCLI itself reads — the value lives in the vault, not in any nanoclaw `.env`.

### Approval-gating credentialed actions

Optional. If a secret is high-blast-radius (production DB writes, payment APIs), configure an approval rule via the OneCLI web UI at `http://127.0.0.1:10254`. The host's `src/modules/approvals/onecli-approvals.ts` long-polls `GET /api/approvals/pending` and routes pending approvals to an admin DM via `pickApprover` + `pickApprovalDelivery`. Approvers are resolved from `user_roles` — scoped admin → global admin → owner.

As of `onecli@1.3.0`, the CLI does not expose approval-rule creation. Web UI only.

---

## Container MCP tool layout

Skill-installed MCP tools live at `container/agent-runner/src/mcp-tools/<your-tool>.ts`. The barrel at `container/agent-runner/src/mcp-tools/index.ts` imports each module for its side-effect `registerTools([...])` call — there is no central tool list.

### Minimal tool module

```ts
// container/agent-runner/src/mcp-tools/example-api.ts
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const fetchExampleResource: McpToolDefinition = {
  tool: {
    name: 'fetch_example_resource',
    description: 'Fetch a resource from the Example API.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Resource id' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    const id = args.id as string;
    try {
      const res = await fetch(`https://api.example.com/v1/resources/${id}`);
      if (!res.ok) return err(`Example API returned ${res.status}`);
      const body = await res.json();
      return ok(JSON.stringify(body));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([fetchExampleResource]);
```

The `McpToolDefinition` shape lives in `container/agent-runner/src/mcp-tools/types.ts`:

```ts
export interface McpToolDefinition {
  tool: Tool; // MCP SDK Tool type
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}
```

### Wiring it in

Append one line to `container/agent-runner/src/mcp-tools/index.ts`:

```ts
import './example-api.js';
```

That's it. `registerTools` runs at import time; the registry self-populates before `startMcpServer()`. No central list to update, no factory function to call.

Note the `.js` extension on imports — agent-runner is a Bun ESM tree. Source files are `.ts`; imports refer to the `.js` they compile to.

### Auth — do nothing

Do not pass an API key to `fetch()`. Do not read `process.env.EXAMPLE_API_KEY`. The OneCLI gateway injects the header for you based on the request hostname. If the agent is in `all` secret mode (or the secret is explicitly assigned), the call succeeds. If it is in `selective` mode with no assignment, it gets `401` — that is the trigger to run `onecli agents set-secret-mode --mode all`, not to plumb a key through code.

If the API has a non-standard auth scheme that OneCLI cannot proxy (e.g. request-signing), file an issue first — host-injected env vars are not the answer.

---

## Test pattern

Container-side tests use **`bun:test`**, not vitest. Vitest runs on Node and cannot load `bun:sqlite`. The root `vitest.config.ts` already excludes `container/agent-runner/`.

```ts
// container/agent-runner/src/mcp-tools/example-api.test.ts
import { describe, it, expect } from 'bun:test';
import { fetchExampleResource } from './example-api.js';

describe('fetch_example_resource', () => {
  it('returns the resource body on success', async () => {
    // Mock fetch as needed; bun:test supports `mock.module(...)`.
    const result = await fetchExampleResource.handler({ id: 'abc' });
    expect(result.isError).toBeUndefined();
  });
});
```

Run from the repo root:

```bash
cd container/agent-runner && bun test
```

### SQL pattern (if your tool reads/writes a session DB)

`bun:sqlite` requires `$name`-prefixed params in **both SQL and JS keys** — it does not auto-strip the prefix the way `better-sqlite3` does on the host:

```ts
db.query('SELECT * FROM messages_in WHERE id = $id').get({ $id: msgId });
```

Positional `?` params work normally. Pragmas — including `journal_mode=DELETE` for cross-mount visibility — are set in `container/agent-runner/src/db/connection.ts`; do not override per-tool.

---

## pnpm vs Bun — which side uses which

| Side                                  | Runtime | Manager | Lockfile         | Release-age gate                   |
| ------------------------------------- | ------- | ------- | ---------------- | ---------------------------------- |
| Host (`src/`, top-level)              | Node    | pnpm    | `pnpm-lock.yaml` | `minimumReleaseAge: 4320` (3 days) |
| Container (`container/agent-runner/`) | Bun     | Bun     | `bun.lock`       | None                               |

Rules:

- **Adding a runtime dep your MCP tool needs** → edit `container/agent-runner/package.json`, then `cd container/agent-runner && bun install`. Commit `bun.lock`. Do not run `pnpm install` in that tree — it is not a pnpm workspace.
- **Pinning** is on you. Bun has no release-age policy on this tree. Check npm release dates before adding or bumping a runtime dep. Never `bun update` blindly.
- **Never edit `pnpm-workspace.yaml` `minimumReleaseAgeExclude` or `onlyBuiltDependencies`** without explicit human sign-off (see `CLAUDE.md` → "Supply Chain Security").
- **CLIs the agent invokes at runtime** (e.g. `agent-browser`, `claude-code`) go in the Dockerfile's pnpm global-install block, pinned via an `ARG`. Not `bun install -g` — that bypasses the supply-chain policy.

A container image rebuild is required for any change inside `container/agent-runner/` to take effect: `./container/build.sh`, then restart the service. `npm run build` alone does not rebuild the image.

---

## Never do this (v1 ghosts)

These patterns were valid in v1 and are wrong in v2. They will be rejected on review.

- **Python wrapper scripts on the host** that the agent shells out to. The agent does not shell out to the host; there is no shared filesystem path for ad-hoc helpers. Skill code is TypeScript inside the container.
- **A new `src/channels/<your-api>.ts` on the host.** That directory is for **inbound** chat-platform adapters only. Outbound API calls live in the container, not the host.
- **IPC bridges, named pipes, stdin piping, file watchers** between host and container. The two session DBs are the only IO surface. If you need new cross-boundary state, add a message kind, not a side channel.
- **`config/private.yaml` or any host-side secret file.** Credentials live in the OneCLI vault. Period.
- **`process.env.MY_API_KEY` in container code.** The container never sees raw secret values; the gateway injects headers. If your tool reads env vars for auth, you are writing v1.
- **A host-side scheduler, cron job, or `setInterval` that calls your API on a timer.** Use the `schedule_task` MCP tool (`container/agent-runner/src/mcp-tools/scheduling.ts`) which writes a `kind='task'` row to `inbound.db` — the host sweep wakes the container at the right time and the call happens in-container, with the right credentials.
- **Touching `data/v2.db` from your tool.** That is the central DB, host-owned. Container tools read/write the **session** DBs (`inbound.db` for reads, `outbound.db` for writes) only.

---

## Worked example — hello-world API skill

End-to-end shape for an API skill that fetches a weather forecast through OneCLI.

### 1. Vault — register the secret (one-time, human runs this)

```bash
onecli secrets create \
  --name "OpenWeather" \
  --host-pattern "api.openweathermap.org" \
  --header "X-API-Key: ${OPENWEATHER_API_KEY}"
```

### 2. Agent — assign the secret

```bash
# Easiest: flip the agent to all-secrets mode.
onecli agents set-secret-mode --id <agent-id> --mode all
```

### 3. Tool — `container/agent-runner/src/mcp-tools/weather.ts`

```ts
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({
  content: [{ type: 'text' as const, text: `Error: ${text}` }],
  isError: true,
});

export const getWeather: McpToolDefinition = {
  tool: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
  },
  async handler(args) {
    const city = encodeURIComponent(args.city as string);
    // No api_key in the URL — OneCLI injects X-API-Key for us.
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric`);
    if (!res.ok) return err(`OpenWeather returned ${res.status}`);
    const body = (await res.json()) as { main?: { temp?: number }; weather?: { description?: string }[] };
    const temp = body.main?.temp;
    const desc = body.weather?.[0]?.description ?? 'unknown';
    return ok(`${desc}, ${temp}°C`);
  },
};

registerTools([getWeather]);
```

### 4. Barrel — `container/agent-runner/src/mcp-tools/index.ts`

```ts
import './weather.js';
```

### 5. Test — `container/agent-runner/src/mcp-tools/weather.test.ts`

```ts
import { describe, it, expect } from 'bun:test';
import { getWeather } from './weather.js';

describe('get_weather', () => {
  it('reports a temperature for a known city', async () => {
    const result = await getWeather.handler({ city: 'London' });
    expect(result.isError).toBeUndefined();
  });
});
```

### 6. Rebuild + restart

```bash
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

No host code changed. No new env var. No new file outside `container/agent-runner/src/mcp-tools/`. The agent now has a `get_weather` tool, authenticated via OneCLI, with no secret in any nanoclaw config file.

---

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — skill taxonomy + SKILL.md format rules
- [docs/agent-runner-details.md](agent-runner-details.md) — agent-runner internals, MCP tool interface
- [docs/v1-to-v2-changes.md](v1-to-v2-changes.md) — host/container split, credential model, lockfile policy
- [docs/build-and-runtime.md](build-and-runtime.md) — Node+pnpm vs Bun split, image build surface
- [container/skills/onecli-gateway/SKILL.md](../container/skills/onecli-gateway/SKILL.md) — the in-container skill that teaches the agent how the proxy works
