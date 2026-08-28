# v4 — the control plane

**Branch: `v4`.** Everything here is additive. A user who installs v4 and changes
nothing gets v3 behaviour, byte for byte. That constraint is not negotiable: this
package has external users, and the whole point is that the new surface is opt-in.

## The idea

v3 is an SSH engine an agent talks to. It already holds the pieces of a control
plane — per-server security modes, an append-only audit log, tunnels, sessions,
keys, groups — but they are invisible: configured through environment variables,
observed by reading a file.

v4 makes them usable, and adds the one thing missing: **the ability to stop an
action and ask a human.**

The engine stays MIT, headless, installable with `npm` alone. The interface is
optional and never required for the engine to run.

## Status

| Piece | State |
|---|---|
| **Encrypted vault** (`src/secret-store.js`) | **done** — AES-256-GCM, key in the OS keychain with a file fallback |
| **`ssh-manager vault`** (`cli/vault.js`) | **done** — list, add, remove, import, status |
| Loader integration | **done** — vault sits above files, below the process environment |
| **Approval broker** (`src/approval.js`) | **done** — pause an action, ask a human, deny on any failure |
| Control plane UI | next |
| Homebrew formula | after that |

## Done: the vault

The only way to give a server a password used to be clear text in a `.env`. Now:

```bash
ssh-manager vault import      # copy what you already have, encrypted
ssh-manager vault list        # see it, without ever printing a secret
ssh-manager vault add prod    # add one interactively
ssh-manager vault status      # where the vault and its key live
```

Decisions worth keeping:

- **Only secret values are encrypted.** Hosts, users, ports and modes stay
  readable, because hiding them buys nothing and makes the file impossible to
  reason about or diff.
- **GCM, not CBC.** Authenticated: a tampered vault throws instead of returning a
  wrong password that would then be sent to a production server.
- **Listing never unlocks.** Asking "which servers exist" must not trigger a
  keychain prompt.
- **`SSH_MANAGER_KEY_SOURCE=file`** skips the keychain, for CI, containers and
  plain SSH logins with no desktop session.
- **A corrupt vault never blocks the other sources.** `.env` and TOML still load.

## Done: the approval broker

It went in where predicted — inside `applyServerPolicy()`, the single choke point
all sixteen handlers already call, and which was already `async`. No handler
signature changed.

```env
SSH_SERVER_PROD_APPROVAL=destructive   # never (default) | destructive | always
```

Protocol: one JSON object per line over a local stream socket. The engine writes
a request and waits for a reply carrying the same `id`, so a control plane is
implementable in any language and debuggable with `nc`.

```json
{"id":"…","server":"prod","host":"…","tool":"ssh_execute",
 "command":"rm -rf /var/www","destructive":true,"args":{…}}
{"id":"…","decision":"deny","reason":"not tonight"}
```

Rules that matter more than the happy path:

- **Every failure denies.** Timeout, unreachable socket, connection dropped
  mid-review, unreadable reply, or a reply carrying the wrong `id` — all refuse.
  The one exception is *approval configured but nothing listening*: that allows
  and says so loudly in the audit log, because failing shut would break every
  agent the moment the UI is closed.
- **The deadline is not optional.** `SSH_MANAGER_APPROVAL_TIMEOUT_MS`, 120s by
  default. A crashed control plane fails one action, never the session.
- **No secret leaves the engine.** The request carries the same sanitized view
  the audit log records — one redaction implementation, not two that drift.
- **The destructive list is deliberately short.** A prompt that cries wolf gets
  clicked through without reading, which is worse than no prompt at all.

Found while testing end to end, both now guarded:

- The `approval` field existed in the module but was never parsed by the config
  loader. Every unit test passed because they built the config object directly.
  Only driving the real MCP server caught it.
- A Unix socket path over 104 bytes fails `bind()` with **EADDRINUSE on a path
  where nothing is listening** — an hour of confusion. `isControlPlaneListening`
  now checks the length and says what is wrong.

## Next: the interface

Two screens, and only two, until they prove their worth:

- **The timeline** — what the agents did. The audit log is already JSONL; this is
  a reader, not a new data source.
- **The approval queue** — what is waiting, on which machine, what it will do.

Explicitly **not** in the first version: terminal, SFTP browser, file editor.
That market has an incumbent with nine months' head start and a release every
five days. A control plane that opens on a terminal is just a late SSH client.
The first screen has to be the one nobody else shows.

## Non-negotiables

1. `npm install mcp-ssh-manager` keeps working with no vault, no UI, no socket.
2. No new runtime dependency in the engine for any of this.
3. Every credential path stays covered by the injection and redaction tests.
4. The engine never requires the interface. The arrow only points one way.
