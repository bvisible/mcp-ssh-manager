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
| **Control plane** (`src/control-plane.js`, `cli/control.js`) | **done** — approval queue + timeline, no dependency |
| **Homebrew formula** (`Formula/ssh-manager.rb`) | **done** — kept current by the release workflow |
| **Desktop app** (`desktop/`) | **done** — native macOS window, 104 KB |
| **Live command streaming** (`src/live-stream.js`) | **done** — watch the agent work, as it happens |
| **Server health** | **done** — on-demand probes, never in the background |

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

## Done: the control plane

```bash
ssh-manager control      # prints a tokenised localhost URL, runs in the foreground
```

Three screens: **your servers** (add, edit, delete — the vault behind a form),
**what is waiting for you**, and **what your agents did**. No terminal, no SFTP browser — that market has an
incumbent with nine months' head start, and a control plane that opens on a
terminal is just a late SSH client.

Not an Electron app, and **no new dependency**: Node's `http` and `net` plus one
HTML file. It therefore runs anywhere the engine runs, including on a server
reached through the tunnels this project already manages, and it can be wrapped
in a desktop shell later without rewriting anything.

### The token is not decoration

This process approves root shell commands, and an unauthenticated HTTP server on
localhost is reachable by every process on the machine **and by any web page the
user has open** — a page can POST to 127.0.0.1. Without a secret, a visited
website could approve an agent's `rm -rf`. Hence, all tested:

- a random token on every request, compared in constant time;
- the `Host` header must be a loopback literal, which is what stops DNS
  rebinding (a hostile domain resolving to 127.0.0.1);
- the listener binds `127.0.0.1`, never `0.0.0.0`;
- the page is served `no-store` under a CSP of `default-src 'none'`, and loads
  nothing from the network.

### Managing servers from the page

The vault is editable from the browser, not only the CLI — both drive the same
`SecretStore`, so they cannot disagree about what is stored.

- **A secret never travels to the page.** Listing returns `hasPassword: true`,
  never the value. The form cannot display one, so it does not ask for one back:
  editing a port keeps the stored password rather than wiping it.
- **Deleting takes two clicks** on the same button, not a `confirm()` dialog — a
  browser modal freezes the automation this page is tested with, and the second
  click is enough friction. The armed state lasts 10 seconds, long enough to
  actually read which row it belongs to.
- Names are validated server-side (`[a-z0-9_]+`), because a name is the vault
  key and a bad one is a second entry rather than an error.

### Behaviours that matter

- **Closing the control plane refuses what is pending** rather than leaving
  agents to hit their own timeouts.
- **Deciding twice returns 409** instead of writing to a closed socket — two
  browser tabs, two clicks.
- **The timeline follows the audit log**, so it shows actions that never needed
  approval, and survives a malformed line.
- The engine giving up first removes the entry, so the UI never offers a
  decision nobody is waiting for.

Found by the test: an audit file that is empty when the control plane starts had
its offset left unset, so every later line was skipped as history.

## Done: Homebrew

```bash
brew tap bvisible/mcp-ssh-manager https://github.com/bvisible/mcp-ssh-manager
brew install ssh-manager
```

The formula installs the **same npm package**, so `brew` and `npm install -g`
give identical binaries. There is no separate desktop build to keep in step: the
vault, the approval broker and the control plane all live in the engine.

It sits in this repository rather than a separate tap, so it is updated in the
same commit as the release that changes it — and the release workflow rewrites
its `url` and `sha256` automatically. A formula pinning a stale version is worse
than no formula at all: `brew install` would quietly hand people the previous
release.

Its `test do` block does a real MCP stdio handshake rather than checking
`--version`, because a formula that only proves the binary exists proves nothing
about whether the package works.

> A short `brew install bvisible/tap/ssh-manager` would need a separate
> `bvisible/homebrew-tap` repository. Worth doing if the formula gets traction;
> not worth a second repository to maintain before then.

## Done: the desktop app

```bash
./desktop/build.sh          # produces desktop/build/SSH Manager.app
```

A real window: dock icon, double-click, no terminal. It starts
`ssh-manager control` as a child process, reads the tokenised URL from its
output, and shows that page in a `WKWebView`.

**Not Electron.** What has to be displayed is one HTML page the engine already
serves over localhost; Electron's runtime alone is 19 MB before any application
code, and a packaged app is well past a hundred. This bundle is **100 KB** and
ships no browser of its own — one Swift file, `swiftc`, and a hand-assembled
bundle, so there is no Xcode project and no package manager in the way.

The trade-off is honest: **macOS only**. Elsewhere `ssh-manager control` opens
the same interface in the browser. A Windows and Linux shell would need a
different toolkit, and is not worth building before the app proves useful.

Details that matter more than they look:

- **A GUI app launched from Finder does not inherit your shell's PATH**, so
  `node` and `ssh-manager` are invisible to it. The app searches the usual
  install locations and, failing that, asks your login shell — which is how it
  finds anything nvm, asdf or volta set up.
- **`SSH_MANAGER_CLI` overrides which CLI is launched.** Found the hard way: this
  machine had an older global install that predated the `control` command, so
  the app dutifully started the wrong binary.
- **Quitting kills the child.** It holds the approval socket; leaving it running
  would keep agents blocked on a UI nobody can see.

## Done: watching the agent work

A fourth screen — **Live** — showing what agents are running while they run it,
output included. This is the thing no command line can offer, and the reason to
have a window at all.

```
prod   tail -f /var/log/app/deploy.log      running
  [08:14:04] step 14/14 — deploying release 2026.08.29
  warning: 2 stale releases left on disk
```

**The scrollback idea comes from TransHub's PtyService** — a bounded circular
buffer per stream, so a window opened mid-command shows what came before rather
than starting blank. Same author, relicensed here under MIT with the rest of the
engine.

Two rules the module may never break, both tested:

- **Nobody watching costs nothing.** No socket → `openStream()` returns null,
  every call site optional-chains it away, and the command runs exactly as it
  did before. One `stat()` per command is the entire overhead.
- **A watcher can never break or slow a command.** Fire-and-forget writes, a
  subscriber that throws is contained, and the control plane vanishing
  mid-command does not throw into the execution path.

A **second socket**, next to the approval one: approval is a request/response
that blocks a command, streaming is a one-way firehose. Sharing one socket would
let a slow reader of the firehose delay a decision.

### What is deliberately not here

No PTY and no xterm.js. Watching an agent needs the `exec` stream, which ssh2
already gives us; a PTY (colours, `top`, `vim`, resize) is a different code path
and xterm.js is a dependency and a bundle. If interactive control is wanted
later, both belong in the desktop app, not the engine.

## Done: server health

A fifth screen. Press the button, get CPU, memory, disk and uptime per machine,
with a gauge that turns amber past 80% and red past 90%.

**Nothing is probed in the background.** Each probe is an SSH handshake, and a
control plane that connects to every production box on a timer is worse than no
dashboard: it is a machine quietly opening sessions nobody asked for. The button
is the whole scheduling policy.

Almost none of this was new code — `buildComprehensiveHealthCheckCommand()` and
`parseComprehensiveHealthCheck()` already existed for the `ssh_health_check`
tool. The control plane opens its own connection (it holds the vault, so it has
the credentials) and closes it immediately after.

Two things the tests pinned down:

- **Unreachable is a result, not an error.** It returns HTTP 200 with the reason
  and how long it took, because "prod did not answer" is exactly what an
  operator opened the screen to find out.
- **Probes run in parallel**, asserted by comparing two servers against one. A
  dashboard over ten machines would otherwise take ten timeouts.

And one real fix the test forced: `readyTimeout` was hard-coded at 60 seconds,
so checking two unreachable servers took a full minute. Callers can now shorten
it, and the probe uses 8 seconds — a machine that has not answered by then is
unreachable as far as a screen is concerned.

## Non-negotiables

1. `npm install mcp-ssh-manager` keeps working with no vault, no UI, no socket.
2. No new runtime dependency in the engine for any of this.
3. Every credential path stays covered by the injection and redaction tests.
4. The engine never requires the interface. The arrow only points one way.
