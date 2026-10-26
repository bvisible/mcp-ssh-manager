# Upgrading from 3.8 to 4.0

**4.0 is released, on npm and as a desktop application**; the latest is 4.0.1 ([release](https://github.com/bvisible/mcp-ssh-manager/releases/tag/v4.0.1)).
The last 3.8 release is 3.8.7, for anyone who pins the 3.8 line.

The upgrade path preserves headless npm/CLI use. The application, vault import
and approval settings are optional.

## Getting 4.0

**The desktop application:** `ssh-manager app` installs the one matching your
engine, checked against the release, or download it from
[the release](https://github.com/bvisible/mcp-ssh-manager/releases/tag/v4.0.0). The
macOS build is signed and notarized; the Windows installer is **not code-signed
in 4.0.0** (Windows warns: *More info → Run anyway*; its SHA-256 is in
`release-manifest-win32.json` on the release, which `ssh-manager app` checks);
Linux ships `.deb` and `.AppImage`.

**The npm engine and interface, side by side with your current install** —
nothing global changes, your MCP client keeps using 3.8.x:

```bash
npm install --prefix ~/ssh-manager-v4 mcp-ssh-manager@4
~/ssh-manager-v4/node_modules/.bin/ssh-manager control   # prints a local URL
```

It reads the same `.env`, TOML and `~/.ssh-manager` as your installation, and
behaves as 3.8.x until you adopt something new. To let an agent use it, add it
as a second MCP server and remove it when you are done:

```bash
claude mcp add ssh-manager-v4 ~/ssh-manager-v4/node_modules/.bin/mcp-ssh-manager
claude mcp remove ssh-manager-v4
```

## From npm to the application, and back

Your AI tools start whichever ssh-manager their settings name. Installing the
desktop application changes none of them: they keep starting the npm engine,
and the application shows what that engine does (approvals, live output) as the
window on top of it.

To have a tool start the application's engine instead — say, to stop
maintaining Node and npm — open **Options → AI tools** in the application and
press *Use the app* for that tool. The same tab, opened from
`ssh-manager control`, works the other way. What it does:

| Tool | Where the entry lives | How it is changed |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope) | `claude mcp remove` + `claude mcp add-json` when the command is installed; otherwise that one key of the file |
| Claude Desktop | its `claude_desktop_config.json` | That one key, **only while Claude Desktop is closed** (it rewrites the file when it quits) |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | The `[mcp_servers.ssh-manager]` table, replaced where it stands; comments and other tables kept |

The entry's environment variables (`SSH_ENV_PATH`, `SSH_CONFIG_PATH`…) are kept,
so the same servers are read either way. The application's engine is the
application binary with `ELECTRON_RUN_AS_NODE=1` and its bundled
`resources/engine/src/index.js`: no Node needed. Restart the tool (or start a
new Claude Code session) afterwards. *Use npm* switches back.

Nothing is offered from an AppImage or from a disk image that was never copied
to Applications: their path changes on the next start, and an entry pointing
there would stop working.

## How 4.0.0 reaches you

```bash
npm update -g mcp-ssh-manager     # crosses the major version: 3.8.x → 4.0.0
```

Two ways it can reach you without that command, both covered by the upgrade test
below:

- **A routine `npm update -g`** updates every global package, and it does cross
  major versions (verified). You will get 4.0.0 the first time you run it.
- **An MCP client configured with `npx mcp-ssh-manager`** and no version starts
  the latest release each time. It picks up 4.0.0 at its next start.

To stay on 3.8 for now, pin it: `npm install -g mcp-ssh-manager@3`, or
`npx mcp-ssh-manager@3` in the client configuration.

Your `.env`, your TOML file, your environment variables, your security modes,
your groups remain supported. Starting the MCP engine does not start an
interface or create a vault, and nothing tells you about one: no invitation, no
banner, no hint in scripts, help, version output or MCP stdout. The interface and
the desktop application are there for whoever wants them (`ssh-manager control`,
`ssh-manager app`, key `a` in the menu) and silent for whoever does not.

`npm run test:published-upgrade` installs the actual published 3.8.5, upgrades
to this checkout's npm tarball, and rolls back. It compares the 37 MCP tool
schemas, server listings and all configured fields using `.env`, TOML and process
environment fixtures. Secrets are compared without being printed. See
[the test guide](TESTING-V4.md) for the remaining platform validation.

## The one thing that behaves differently: host keys

3.8.5 **never compared host keys**. Its check looked a host up in
`~/.ssh/known_hosts`, and accepted the connection whether or not the key the
server presented matched — so it could not tell your server from someone
pretending to be it. V4 compares the actual key, on every connection:

| The host is… | 3.8.5 | V4 |
|---|---|---|
| Not in `known_hosts` | Connected, recorded nothing | Connects, and **records its key** in `known_hosts` — trust on first use, what `StrictHostKeyChecking accept-new` does |
| In `known_hosts`, same key | Connected | Connects |
| In `known_hosts`, **different key** | Connected anyway | **Refused, before any credential is sent** |
| Marked `@revoked` | Connected anyway | Refused |

The refusal reads:

```
SSH host key changed or is not trusted for prod.example.com:22; verify the
server identity before updating known_hosts
```

**This is the one case where something that worked on 3.8.5 stops working**, and
it is deliberate: a changed key is exactly what an interception looks like. It
usually means the server was rebuilt or reinstalled. Plain `ssh` refuses the same
host with *REMOTE HOST IDENTIFICATION HAS CHANGED*, so if you also use `ssh`
directly you have likely met it already.

If the server was legitimately rebuilt, **check its new fingerprint through a
channel you trust** — the hosting provider's console, whoever rebuilt it — then
remove the old entry and reconnect:

```bash
ssh-keygen -R prod.example.com            # port 22
ssh-keygen -R '[prod.example.com]:2222'   # any other port
```

or **Options → Known hosts** in the application. The next connection records the
new key.

`SSH_MANAGER_KNOWN_HOSTS=/path/to/file` points V4 at a separate file, if you
would rather it did not add entries to the `known_hosts` your own `ssh` uses.

## What is new, and optional

An **encrypted vault**. Instead of credentials sitting in clear text in a
`.env`, secrets are stored with AES-256-GCM under a key held in your OS
keychain. Hosts, ports, users and modes stay readable, so the file can still be
inspected and diffed — only the secrets are opaque.

The vault sits **above** your files, not in place of them:

```
process environment          ← connection settings (never approval)
  └── vault                  ← wins for servers it holds
        └── .env / TOML      ← everything else, exactly as before
```

A server in the vault is served from the vault. A server only in your `.env` is
served from your `.env`. Both at once is a normal state, not a broken one — you
can move servers over one at a time, or never.

## Going further: the setup V4 makes possible

Nothing here is required, and none of it happens on its own. In the order that
keeps you able to go back at every step:

1. **Move credentials out of the clear-text `.env`.** `ssh-manager vault import`,
   or **Import it** from the banner in the application. The secrets are
   encrypted with a key held in your OS keychain; your `.env` is not touched.
2. **Make a recovery backup, and check it.** **Options → Vault → Create a
   recovery backup**, or `ssh-manager vault backup <file>`, then
   `ssh-manager vault status` (look for `Readable  yes`). The vault's key never
   leaves this machine; the backup, under a passphrase you choose, is what does.
3. **Run something real against a server.** Only then, if you want to, remove
   the secrets from your `.env`. Until you do, rolling back to 3.8.5 stays one
   command.
4. **Decide how far an agent can go on each server.** `readonly` refuses every
   mutating tool; `restricted` runs only commands matching your allow patterns.
   Both already existed in 3.8 — see [SECURITY_MODES.md](SECURITY_MODES.md).
5. **Require your approval where it matters.** **Servers → the server →
   Approval → destructive** (or **always**). The agent pauses until you decide,
   seeing the command in full. When approval is required and the application is
   not open, the request is **refused**, never let through.
6. **Keep a record.** The **Activity** screen shows what ran and what you
   decided; `AUDIT_LOG` per server writes it to a file as well.
7. **Let your servers know an agent is driving.** `SSH_MANAGER_ANNOUNCE_AGENT=true`
   (or `ANNOUNCE_AGENT=true` per server) sends `AI_AGENT=mcp-ssh-manager` with
   every command; add `AcceptEnv AI_AGENT` to the server's `sshd_config` so it
   keeps it. Off by default — see the README for why.

## Moving a server into the vault

Either from the interface — `ssh-manager control` shows a banner naming the file
and the servers still in it — or from the command line:

```bash
ssh-manager vault import          # reads configured .env / TOML, encrypts, writes the vault
```

**Your `.env` is not modified.** Not by `import`, not by the interface, not
ever. Removing secrets from it is a separate decision, and one to make only
after the next section.

For an existing npm setup, open `ssh-manager control` and choose **Import it**
from the banner. For a new setup, the illustrated welcome takes you directly to
**Add a server** or **Import servers**. Neither flow is shown by the headless engine.

## Before you delete anything: the key does not travel

The vault's key lives in **this machine's** keychain. It is not in the vault
file, and it does not follow the vault to a backup, a sync folder or a new
laptop. Copy the vault to another machine and it is a file of ciphertext nobody
can open.

That is the right trade for a key — but it means that the moment your vault is
the *only* copy of a credential, one wiped keyring stands between you and a
locked-out afternoon.

From the application, use **Options → Vault → Create a recovery backup**.
Choose and confirm a passphrase, then save the encrypted download. Restore from
that same screen: choose the file, enter its passphrase, review the server names
and replacements, then confirm. A preview writes nothing; if another process
changes the vault, a fresh preview is required.

A recovery backup contains saved servers and credentials. It does **not** include
groups, preferences, host keys or your original configuration files. Back these up
separately. Private-key paths do not embed the SSH key files they point to.

From the CLI, in this order:

```bash
# 1. A copy that does not depend on this machine
ssh-manager vault backup ~/ssh-manager-recovery.json

# 2. Confirm this machine can actually decrypt what it wrote
ssh-manager vault status        # look for: Readable   yes

# 3. Run something real against a server

# 4. Only now, if you want to, remove the secrets from your .env
```

The recovery file is encrypted with a **passphrase you choose**, not with the
machine key. Keep it where you keep passwords — a password manager will hold it
as an attachment. Unlike the vault, it reveals nothing at all without the
passphrase, not even a hostname, because it is meant to be stored somewhere less
trusted.

There is no way to recover that passphrase. If you lose it, the file is noise.

## On a new machine

```bash
ssh-manager vault restore ~/ssh-manager-recovery.json
```

It asks for the passphrase, tells you what the file holds before you type
anything, and warns before replacing a server that already exists.

## If the vault is damaged or the key is gone

A vault you chose to use must not silently lose its protections. If it exists
but cannot be parsed or completely decrypted, MCP calls stop with a recovery
error instead of falling back to potentially less restrictive old files. This
also applies after a restart. The application can still open **Options → Vault**
to restore a recovery backup. An installation with no vault keeps its normal
3.8.5 configuration path.


You will be told, plainly, rather than left to find out from a failed deploy:

```
This vault cannot be read on this machine.

The vault at ~/.ssh-manager/vault.json is encrypted with a key this machine no
longer has. A new key was generated, which cannot read it. Nothing has been
overwritten.
```

Three ways out, in order of preference:

1. **A recovery file** — `ssh-manager vault restore <file>`.
2. **The servers are still in a `.env` / TOML** — retain a separate copy of the
   unreadable vault, move it aside, and run `ssh-manager vault import` again. This is why keeping the `.env` for a while
   is a reasonable thing to do.
3. **Neither** — the secrets in that vault are unrecoverable. Move the file
   aside and re-add the servers. The hosts, ports and users are still readable
   in it, so you are re-entering passwords, not rebuilding an inventory.

## Where things live

| | Path | Contains |
|---|---|---|
| Vault | `~/.ssh-manager/vault.json` | servers; secrets encrypted |
| Key | OS keychain, or `~/.ssh-manager/vault.key` (0600) | the master key |
| Recovery file | wherever you put it | saved servers and credentials, under your passphrase |
| Groups | `~/.ssh-manager/groups.json` | shared by npm, CLI and desktop |
| Hooks, aliases, profile | `~/.ssh-manager/hooks.json`, `command-aliases.json`, `server-aliases.json`, `profile` | written only when you change one (since 3.8.6) |
| Logs | `~/.ssh-manager/ssh-manager.log`, `command-history.json`, `errors.log` (0600) | only when `~/.ssh-manager` exists; `SSH_LOG_FILE` / `SSH_HISTORY_FILE` override |

`SSH_MANAGER_HOME` overrides the state directory; `SSH_GROUPS_FILE` overrides
just the groups file. An existing package-local `.server-groups.json` is read
conservatively and copied to user state on the first successful edit. Keep a
copy before removing an older installation if it contains your only groups file.

Up to 3.8.5 the hook settings, the aliases, the active profile, the log and the
command history were written inside the installed package, so an upgrade lost
them. An old file there is still read until your next change writes the new one.

`SSH_MANAGER_KEY_SOURCE=file` skips the keychain entirely — needed in CI, in
containers, and over an SSH session with no desktop keyring.

## Staying on `.env` forever

Entirely supported, and not a second-class path. `npm install mcp-ssh-manager`
with no vault, no `APPROVAL` setting and no control plane running behaves
exactly like 3.8. The control plane is a separate command you run when you want
it; the engine never starts one.

## Which `.env` is read

`SSH_ENV_PATH` names the file explicitly. When it is not set, V4 also honours
`SSH_MANAGER_ENV` — the CLI's variable, which 3.8.x's engine never read. A
profile that still exports `SSH_MANAGER_ENV` towards a file that no longer
exists is skipped with a warning, so the usual discovery (`~/.ssh-manager/.env`,
then the working directory, then your home) applies as it did in 3.8.x. A missing
file named by `SSH_ENV_PATH` stays the choice and is reported at startup, in
`ssh_list_servers` and in "server not found".

## Rolling back to 3.8.7

```bash
npm install -g mcp-ssh-manager@3.8.7
```

3.8.7 reads the original `.env` / TOML / process environment. V4 does not edit
those files during vault import, so keeping them makes rollback possible.
Changes made only in the V4 vault are **not** understood by 3.8.7: retain an
appropriate original configuration and backup before adopting vault-only changes.
An older CLI may also use its older package-local groups file. Do not expect it
to read V4's new user-state groups file automatically.
