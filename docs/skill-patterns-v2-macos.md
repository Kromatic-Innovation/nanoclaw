# Skill Patterns v2 — macOS-Native Bridge (Spike)

**Status:** Spike. Decision recorded; implementation lives in a follow-up issue.
**Scope:** Pattern for v2 skills that need to drive macOS-only APIs from inside a
sandboxed container — Reminders, Calendar, Contacts, AppleScript-bridged
applications, Keychain reads, anything reachable only via `osascript` /
`EventKit` / `Contacts.framework` etc.
**Replaces:** the v1 file-watcher IPC pattern used by `add-apple-reminders`
(host poller watched a JSON file the agent wrote, executed `osascript`, wrote
back a result file the agent picked up). v2 has no file-watcher and no shared
process — see `docs/v1-to-v2-changes.md` → "Host process vs containers".

## Why a spike doc

v2's architecture forbids the v1 approach by construction:

- Host and container share **only** the two session DBs (`inbound.db`,
  `outbound.db`). No file watcher, no shared modules, no stdin piping.
- The container is a per-session sandbox. It cannot run `osascript`; the
  binary doesn't exist there and even if it did, the container is a Linux
  VM (Apple Container) or a Linux Docker container — not macOS.
- Secrets live in the OneCLI Agent Vault (`127.0.0.1:10254` on the host);
  the container never sees raw credential values. Any new host-side bridge
  must respect that boundary or it becomes a trivial escape hatch.

So a v2 "drive macOS from a skill" pattern has to be designed, not ported.
This doc evaluates four candidate patterns and picks one.

## The four candidates

Numbered as in issue #68.

1. **Host webhook bridge** — host runs a tiny HTTP server on
   `127.0.0.1:<port>`; container POSTs JSON over the existing Apple
   Container `bridge100` (or Docker `host.docker.internal`). Host endpoint
   dispatches to `osascript` (or native Swift helper), returns JSON.
2. **Mounted host shell wrapper** — bind-mount a host directory containing
   wrapper scripts into the container; container `exec`s them. Wrapper
   re-enters the host via some shell-out mechanism.
3. **Container-side AppleScript bridge** — install `osascript` (or a
   Swift/EventKit shim) inside the container and call macOS APIs from
   there.
4. **Host-side MCP over Unix socket** — host runs a long-lived MCP server
   exposing macOS tools (`reminders.create`, `calendar.list`, …);
   container connects to it via a bind-mounted Unix socket and consumes
   those tools through the standard MCP client the agent-runner already
   uses.

## Evaluation

| Criterion                                           | 1. Host webhook                                                                                                                                                                                                                                                                                                                                                                    | 2. Mounted shell wrapper                                                                                                                                                                                                                                                                                                                | 3. Container-side AppleScript                                                                                                                                   | 4. Host-side MCP over Unix socket                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Security — token boundary**                       | OK. Host endpoint is the trust boundary; can require a per-session shared secret seeded into `inbound.db` at spawn and rotated. Container never sees host filesystem or Keychain. Same posture as OneCLI gateway.                                                                                                                                                                  | **Broken.** Bind-mounting host scripts means the container ABI is "anything that script can do." A script that calls `osascript` runs in the **host** user's session with full Keychain / Reminders / Mail / file-system / SSH-key access. There is no way to scope it down without re-inventing the webhook bridge inside the wrapper. | N/A — doesn't reach the host, so no boundary to discuss; the boundary is moot because the operation never happens.                                              | OK. Same posture as the webhook: the socket is the boundary, peer-cred check via `SO_PEERCRED` / `getsockopt(LOCAL_PEERPID)` is possible. MCP transports already standardize auth headers.                                                                                                                                                             |
| **Portability — Linux fallback for non-Mac skills** | Fine. Same pattern works on Linux for any "host has a thing the container can't reach" skill (e.g. a Linux `dbus` bridge, a Windows COM bridge). The pattern is OS-agnostic; only the dispatcher is Mac-specific.                                                                                                                                                                  | Fine in principle (Linux can also bind-mount + shell-exec), but the security cost is identical or worse on Linux.                                                                                                                                                                                                                       | **Mac-only forever.** No way to make `osascript` work on a Linux container; even if we ship a macOS container someday, that's a totally different runtime path. | Fine. MCP is the agent-runner's standard tool transport already; a Linux variant of the server (e.g. for KDE / GNOME native integrations) drops in unchanged from the agent's perspective.                                                                                                                                                             |
| **DX — per-skill boilerplate**                      | Low. New skill = (a) one host-side dispatch case (~10–20 lines TS calling `osascript`), (b) one container-side helper that does `fetch('http://<host-ip>:<port>/macos', { body: { op, args } })`. ~30 LoC per skill end-to-end.                                                                                                                                                    | Low surface, high hidden cost. New skill = one shell script in the mount dir + container code to invoke it. Looks cheap until the first security review.                                                                                                                                                                                | Cannot be done; not applicable.                                                                                                                                 | Lowest. New skill = a single new MCP tool registration on the host (~20 LoC). Container side gets it **for free** — agent already auto-discovers MCP tools and the model picks them by description. No per-skill container code.                                                                                                                       |
| **Failure modes**                                   | Webhook port can be busy at startup (pick from a port range, write the live port to `inbound.db` at spawn; document the recovery). Host process dies → all containers see ECONNREFUSED on next call; surface a clear error and exit cleanly, since v2 sessions are already host-shepherded. TLS not needed because traffic never leaves `bridge100`. Rate-limiting is a one-liner. | Wrapper script silently calls anything it wants on the host. Failures are arbitrary shell exits; no structured response. Container can shell-inject if any arg is concatenated. Auditing a privilege escalation means reading every wrapper script in the mount.                                                                        | N/A.                                                                                                                                                            | Socket file disappears (cleanup race on host crash) → container gets ENOENT on next call. Easy to detect and retry once. Same posture as the webhook for "host gone" cases. Unix socket avoids the port-busy problem entirely. One sharp edge: bind-mounting a Unix socket into Apple Container (vs. Docker) — needs verification, see Open Questions. |

## Decision

**Option 4 — Host-side MCP over Unix socket** for the canonical macOS-native
bridge pattern, **with Option 1 (host webhook) as the documented escape
hatch** when MCP isn't a fit (one-shot install-time host probe, very large
binary payloads that don't belong in a tool call, etc.).

The reasoning is that v2 already ships an MCP runtime inside the
agent-runner (`container/agent-runner/src/mcp-tools/*.ts`) and the agent
discovers tools by description without any per-skill prompt engineering.
Every macOS skill becomes "register one more tool on the host MCP server" —
no new container code, no new wire protocol, no new auth scheme. The agent
sees `reminders.create_reminder` the same way it sees the existing built-in
tools, and the OneCLI / approval / audit machinery the host already has
around MCP gets reused for free. The host webhook (Option 1) is a perfectly
fine implementation underneath if MCP turns out to be too heavy for a given
operation, but for the **default skill pattern**, asking skill authors to
reinvent the agent-facing surface for each Mac feature is wasteful when MCP
already exists. Options 2 and 3 are non-starters — Option 2 collapses the
host/container trust boundary that v2 was rebuilt to enforce, and Option 3
contradicts the platform definition of the container.

## Open questions before implementation

These need answers in the implementing PR, not here:

- **Apple Container Unix-socket bind mounts.** Docker bind-mounts a host
  socket into the container as `/var/run/<name>.sock` reliably. Apple
  Container's vmnet model puts the container in a VM (192.168.64.0/24);
  whether a host UDS can be bind-mounted across the VM boundary, or whether
  we need a vsock/TCP fallback on Apple Container, needs a 30-minute probe.
  If UDS-into-VM doesn't work, the bridge falls back to TCP on
  `bridge100` (Apple Container) / `host.docker.internal` (Docker), and the
  "Unix socket" detail of Option 4 becomes "loopback TCP on the bridge,"
  which collapses Option 4 toward Option 1 mechanically — but Option 4's
  developer-facing surface (MCP tool registration) stays identical.
- **Peer-credential auth.** On UDS we can use `SO_PEERCRED`. On TCP we
  fall back to a per-session shared secret minted into `inbound.db` at
  container spawn — the same approach already used for any other host-bound
  bridge would adopt.
- **Lifecycle.** The host MCP server is one process per host (not per
  session). Spawned at `nanoclaw` start, torn down at shutdown.
  Per-session connections are cheap MCP client opens against the shared
  server. This matches OneCLI's lifecycle and avoids per-container cold
  start.
- **OneCLI overlap.** OneCLI already proxies external HTTP. The macOS
  bridge handles _local_ system APIs that have no HTTP surface. They don't
  overlap; document the split in `docs/skill-patterns-v2.md` so skill
  authors know which one to reach for.

## Pseudocode — how `add-apple-reminders` would use this

End-to-end sketch: a `/add-apple-reminders` skill registers a new MCP tool
with the host bridge, and the agent calls it the same way it calls any
other MCP tool.

### Host side — register the tool

```ts
// src/macos-bridge/server.ts (sketch — host process, Node)
//
// One MCP server, started during nanoclaw boot. Listens on a Unix socket
// (or loopback TCP fallback). Skills register tools by importing into
// this module's barrel; install-time skill steps copy a new file in and
// append an import — the same pattern channels use today.

import { McpServer } from '@modelcontextprotocol/sdk/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';

const exec = promisify(execFile);
const SOCKET = '/tmp/nanoclaw-macos-bridge.sock';

export const server = new McpServer({
  name: 'nanoclaw-macos-bridge',
  version: '0.1.0',
});

// --- tool registration (this block lives in the add-apple-reminders skill) ---
server.tool(
  'reminders_create',
  'Create a reminder in Apple Reminders.app on the host.',
  {
    title: { type: 'string', required: true },
    list: { type: 'string', required: false, default: 'Reminders' },
    due_iso: { type: 'string', required: false },
    notes: { type: 'string', required: false },
  },
  async (args, ctx) => {
    // peer-cred / shared-secret check already enforced by the transport layer.
    // Audit log lands in logs/macos-bridge.log with ctx.session_id.
    const script = `
      tell application "Reminders"
        tell list "${shellEscape(args.list ?? 'Reminders')}"
          set newReminder to make new reminder with properties {name:"${shellEscape(args.title)}"}
          ${args.due_iso ? `set due date of newReminder to (current date) + 0` : ''}
          ${args.notes ? `set body of newReminder to "${shellEscape(args.notes)}"` : ''}
        end tell
      end tell
    `;
    const { stdout } = await exec('osascript', ['-e', script]);
    return { ok: true, raw: stdout.trim() };
  },
);

// --- transport bootstrap ---
export function startBridge() {
  if (!existsSync('/tmp')) mkdirSync('/tmp');
  server.listen({ transport: 'unix', path: SOCKET });
  // Fallback in container.ts adds -e MACOS_BRIDGE_URL=tcp://192.168.64.1:<port>
  // when the runtime is Apple Container and UDS bind-mount is unsupported.
}
```

### Container-runner — wire the socket in

```ts
// src/container-runner.ts (sketch additions)
//
// When spawning a session container, mount the host UDS (or pass the TCP
// fallback URL) so the in-container MCP client can reach the host bridge.

function macosBridgeMountArgs(runtime: 'docker' | 'apple-container') {
  if (runtime === 'docker') {
    return ['-v', '/tmp/nanoclaw-macos-bridge.sock:/var/run/macos-bridge.sock'];
  }
  // Apple Container: UDS bind-mount is TBD (see Open Questions). Until
  // confirmed, pass the loopback TCP URL via env and let the in-container
  // MCP client use the TCP transport.
  return ['-e', `MACOS_BRIDGE_URL=tcp://192.168.64.1:${tcpPort}`];
}
```

### Container side — zero new code per skill

```ts
// container/agent-runner/src/mcp-tools/macos-bridge-client.ts (sketch)
//
// Single file, registers ONE MCP client that proxies every tool the host
// bridge advertises. New macOS skills register tools on the host; this
// client picks them up automatically — no per-skill container edits.

import { McpClient } from '@modelcontextprotocol/sdk/client';

export async function registerMacosBridgeTools(registry: ToolRegistry) {
  const url = process.env.MACOS_BRIDGE_URL ?? 'unix:///var/run/macos-bridge.sock';
  const client = new McpClient({ url, authToken: process.env.MACOS_BRIDGE_TOKEN });
  await client.connect();
  for (const tool of await client.listTools()) {
    registry.register({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema,
      handler: (args) => client.callTool(tool.name, args),
    });
  }
}
```

### Skill author's view

A new macOS skill (e.g. `/add-apple-calendar`):

1. `git fetch origin macos-bridge && git show macos-bridge:src/macos-bridge/tools/calendar.ts > src/macos-bridge/tools/calendar.ts`
2. Append `import './tools/calendar.js';` to `src/macos-bridge/tools/index.ts`.
3. Reload the host (`launchctl kickstart …`).

No container edits. No new wire format. The agent now has
`calendar_list_events`, `calendar_create_event`, etc., advertised the same
way it advertises everything else.

## What changes in `docs/skill-patterns-v2.md` (parallel doc, not edited here)

When `docs/skill-patterns-v2.md` lands, it should grow a "host-bound
platform skills" sub-pattern that:

1. References this spike for the rationale and option comparison.
2. Lists the macOS-native bridge as the canonical implementation of the
   sub-pattern, with the Linux equivalent (dbus, etc.) noted as a future
   extension.
3. Distinguishes it from the OneCLI-mediated HTTP-API pattern — OneCLI
   covers external networked APIs with secrets; the host bridge covers
   local system APIs without a network surface.
4. Names the integration point in the skill manifest format: a skill
   declares `host_bridge_tools: [<tool_name>...]` so the host knows which
   tool registrations to expect after install, and `/customize` /
   `/debug` can sanity-check them.

This doc deliberately stops short of editing `docs/skill-patterns-v2.md`
because that file is being authored in parallel (per #68 context). The
integration point above is the only contract this spike commits to.

## Migration note for `add-apple-reminders` (informational, not in scope)

The v1 `add-apple-reminders` skill used a file-watcher IPC bridge: agent
wrote a JSON request file to a shared dir, a host poller picked it up, ran
`osascript`, wrote a JSON response file back. That pattern is dead in v2 by
design (no shared filesystem between host and container beyond the session
DBs). The v2 port is a clean rewrite onto this bridge, **not** a
mechanical translation. Tracked separately.
