# Security Modes (v3.5.0+)

`mcp-ssh-manager` lets you declare a **per-server security mode** to constrain
what an AI agent can do once it's been granted access to the MCP server.
This is **opt-in** — servers without a `MODE` field behave exactly like they
did in v3.4.x.

## Why

Before v3.5.0 the only authorization layer was Claude Code's `autoApprove`
mechanism, which is tool-level and all-or-nothing. Once `ssh_execute` is
auto-approved, anything goes — including `rm -rf /`. Security modes add a
**second filter inside the MCP server itself**, so a server you've marked
`readonly` will refuse destructive commands even if the client allowed
the tool.

This is **not** a kernel sandbox (no seccomp, no container, no namespaces).
It's a defense-in-depth filter against accidents and prompt-injection
attacks, layered between the MCP client and the SSH session.

## The three modes

| Mode | What it does |
|---|---|
| `unrestricted` (default) | No filter. Identical to pre-v3.5.0 behavior. Zero overhead — `evaluatePolicy()` early-returns. |
| `readonly` | Blocks mutating tools at the tool level (`ssh_upload`, `ssh_deploy`, `ssh_sync`, `ssh_execute_sudo`, `ssh_backup_create/restore/schedule`, `ssh_db_import/dump`, `ssh_key_manage` write actions, `ssh_alert_setup` set, `ssh_process_manager kill`). For `ssh_execute` / `ssh_execute_sudo` / `ssh_execute_group` / `ssh_session_send`, applies a built-in denylist (rm, mv, dd, mkfs, chmod, chown, sudo, systemctl restart/stop, docker rm/stop, pipe-to-sh, redirect outside `/tmp`, etc.). |
| `restricted` | All readonly blocks plus: every command must match at least one `ALLOW_PATTERNS` regex AND no `DENY_PATTERNS` regex. **DENY wins over ALLOW**. With no `ALLOW_PATTERNS`, every command is refused (fail-closed). |

## Configuration

### Environment variables / `.env`

```bash
SSH_SERVER_PROD_HOST=prod.example.com
SSH_SERVER_PROD_USER=deploy
SSH_SERVER_PROD_KEYPATH=~/.ssh/id_ed25519

# Security mode (optional — omit to keep pre-v3.5.0 behavior)
SSH_SERVER_PROD_MODE=readonly
SSH_SERVER_PROD_AUDIT_LOG=/var/log/mcp-ssh-prod.jsonl

# For restricted mode
SSH_SERVER_PROD_ALLOW_PATTERNS="^docker (ps|logs|inspect);^kubectl get ;^systemctl status "
SSH_SERVER_PROD_DENY_PATTERNS=" -f $; --force"
```

Patterns are `;`-separated POSIX-ish JavaScript regex (compiled with `new RegExp`).
Invalid regex are logged as warnings and skipped — they do not abort startup.

### TOML

```toml
[ssh_servers.prod]
host = "prod.example.com"
user = "deploy"
key_path = "~/.ssh/id_ed25519"

mode = "restricted"
allow_patterns = ["^docker (ps|logs|inspect)", "^kubectl get ", "^systemctl status "]
deny_patterns = [" -f $", "--force"]
audit_log = "/var/log/mcp-ssh-prod.jsonl"
```

TOML arrays are preferred. A `;`-separated string is also accepted for
parity with the `.env` form.

## Audit log

When `AUDIT_LOG` (`.env`) or `audit_log` (TOML) is set to a file path, every
**gated** tool invocation appends a JSONL record:

```json
{"ts":"2026-05-18T15:30:00.123Z","server":"prod","tool":"ssh_execute","args":{"command":"ls /tmp"},"allowed":true,"exitCode":0,"success":true}
{"ts":"2026-05-18T15:30:14.789Z","server":"prod","tool":"ssh_execute","args":{"command":"rm /tmp/x"},"allowed":false,"reason":"Command refused on server \"prod\" (mode: readonly): matches built-in destructive pattern /(^|[\\s;&|])rm(\\s|$)/."}
```

Secrets (`password`, `passphrase`, `sudoPassword`, `token`, `secret`, `apikey`)
are redacted to `***` before being written, even if a tool somehow passed them
through args.

Log rotation is not handled by `mcp-ssh-manager` — use `logrotate`, `vector`,
or your log shipper of choice. v3.5.0 audits cover the gated tool set:
`ssh_execute`, `ssh_upload`, `ssh_execute_sudo`, plus denials on every other
mutating tool. Pure read tools (`ssh_health_check`, `ssh_db_query`, `ssh_tail`…)
are not audited in v3.5.0 — open an issue if you need full coverage.

## Recipes

### Third-party agent with read-only access

Goal: hand the MCP to an external agent (CI bot, sandbox, third-party LLM
service) that should only be able to **observe** your prod box.

```bash
SSH_SERVER_PROD_HOST=prod.example.com
SSH_SERVER_PROD_USER=observer
SSH_SERVER_PROD_KEYPATH=~/.ssh/observer_ed25519
SSH_SERVER_PROD_MODE=readonly
SSH_SERVER_PROD_AUDIT_LOG=~/.ssh-manager/audit/prod.jsonl
```

The agent can run `ls`, `cat`, `df`, `ps`, `journalctl`, `docker ps`,
`kubectl get`, etc. — but `rm`, `mv`, `sudo`, redirect-to-`/etc/`, `pipe | sh`,
`systemctl restart`, `apt install`, etc. all return a `Policy denied` error
to the MCP client.

### CI bot with a tight allowlist

Goal: an automated bot can only deploy-status commands, nothing else.

```bash
SSH_SERVER_CI_HOST=ci.example.com
SSH_SERVER_CI_USER=ci-bot
SSH_SERVER_CI_KEYPATH=~/.ssh/ci_bot_ed25519
SSH_SERVER_CI_MODE=restricted
SSH_SERVER_CI_ALLOW_PATTERNS="^docker compose ps;^docker compose logs ;^/opt/myapp/bin/healthcheck"
SSH_SERVER_CI_DENY_PATTERNS="--force; rm "
SSH_SERVER_CI_AUDIT_LOG=/var/log/ci-bot.jsonl
```

### Mixed fleet: one strict server, others unrestricted

You can mix modes freely — the policy is evaluated per server, per call.

```bash
# Your dev box — full control, no surprises
SSH_SERVER_DEV_HOST=dev.local
SSH_SERVER_DEV_USER=you
SSH_SERVER_DEV_KEYPATH=~/.ssh/id_ed25519
# (no MODE → unrestricted, behaves like v3.4.x)

# Client's prod box you don't want to break
SSH_SERVER_CLIENT_PROD_HOST=client-prod.example.com
SSH_SERVER_CLIENT_PROD_USER=consultant
SSH_SERVER_CLIENT_PROD_KEYPATH=~/.ssh/consultant_ed25519
SSH_SERVER_CLIENT_PROD_MODE=readonly
SSH_SERVER_CLIENT_PROD_AUDIT_LOG=~/.ssh-manager/audit/client-prod.jsonl
```

## What gets gated, what doesn't

**Fully gated** (policy check at tool entry):
`ssh_execute`, `ssh_execute_sudo`, `ssh_execute_group`, `ssh_session_send`,
`ssh_upload`, `ssh_sync`, `ssh_deploy`, `ssh_backup_create`,
`ssh_backup_restore`, `ssh_backup_schedule`, `ssh_db_import`, `ssh_db_dump`.

**Action-gated** (only the mutating action is checked):
`ssh_key_manage` (only `accept` / `remove`), `ssh_alert_setup` (only `set`),
`ssh_process_manager` (only `kill`).

**Not gated** (pure reads or local-only state — no remote effect to block):
`ssh_list_servers`, `ssh_download`, `ssh_tail`, `ssh_monitor`, `ssh_history`,
`ssh_health_check`, `ssh_service_status`, `ssh_db_list`, `ssh_db_query`
(already SELECT-only), `ssh_backup_list`, `ssh_session_start`,
`ssh_session_list`, `ssh_session_close`, `ssh_connection_status`,
`ssh_tunnel_*`, `ssh_group_manage`, `ssh_command_alias`, `ssh_alias`,
`ssh_hooks`, `ssh_profile`.

## Limitations

- **Not a sandbox.** Once a command is allowed, it runs with the full
  permissions of the SSH user. Use a dedicated low-privilege account for
  servers in `readonly` / `restricted` mode.
- **Regex-based filtering can be bypassed** with creative command crafting
  (encoded payloads, indirection via shell variables, etc.). Treat `readonly`
  as protection against accidents and prompt injection of the common form,
  not as an unbreakable shell escape.
- **Aliases are expanded before policy evaluation** — you can't bypass a DENY
  by hiding `rm` behind an alias defined via `ssh_command_alias`.
- **No transport-level / per-client policies.** All clients see the same
  policy for a given server. If you need different policies per agent, run
  separate MCP server instances with different config files.

## Backward compatibility

A v3.4.x `.env` or TOML loads identically under v3.5.0:

- No `MODE` field → `mode = 'unrestricted'` → `evaluatePolicy()` early-returns
  `{ allowed: true }`. Not a single regex is compiled, not a single byte is
  written to disk.
- `AUDIT_LOG` is opt-in — no log file is created until you set it.
- The interactive wizard (`ssh-manager server add`) defaults all three new
  prompts to "skip" (press Enter and the resulting `.env` block is identical
  to v3.4.x).
- Tool auto-approval (`autoApprove` in `claude_code_config.json`) keeps
  working — the policy intercepts AFTER auto-approval, BEFORE execution,
  so the client never sees a new prompt.

See `CHANGELOG.md` v3.5.0 for the full diff.
