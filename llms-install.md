# Installing MCP SSH Manager — instructions for AI agents

These steps let an AI agent (Cline or any MCP client) set up this server for its
user. Follow them in order. Ask the user for anything you do not know; never
guess a host, a user name or a key.

## 1. Check Node.js

```bash
node --version
```

Version 18 or later is required. If Node is missing or older, ask the user to
install a current LTS from https://nodejs.org before going on.

## 2. Register the server with the MCP client

The server speaks MCP over stdio. Add this entry to the client's MCP settings
(for Cline: `cline_mcp_settings.json`, opened from *MCP Servers → Configure*):

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-manager"]
    }
  }
}
```

`npx` downloads the published package on first use; nothing else needs to be
installed. A user who prefers a global install can run
`npm install -g mcp-ssh-manager` and use `"command": "mcp-ssh-manager"` with no
`args` instead.

## 3. Describe the user's servers

Servers are read from `~/.ssh-manager/.env` (on Windows,
`%USERPROFILE%\.ssh-manager\.env`). Ask the user, for each server: a short name,
the host, the SSH user, the port if it is not 22, and the path of the private key
they use for it. Then create the directory and the file:

```bash
mkdir -p ~/.ssh-manager
touch ~/.ssh-manager/.env
chmod 600 ~/.ssh-manager/.env
```

Append one block per server. The name is the part between `SSH_SERVER_` and the
field, in capitals, with letters, digits and underscores only; the tools refer to
it in lower case (`PRODUCTION` below is `production`).

```env
SSH_SERVER_PRODUCTION_HOST=203.0.113.10
SSH_SERVER_PRODUCTION_USER=deploy
SSH_SERVER_PRODUCTION_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_PRODUCTION_PORT=22
```

Rules that matter:

- **Prefer a key.** Do not ask the user to type a password or a key passphrase
  into the conversation. If a server only accepts a password, tell the user to
  add `SSH_SERVER_<NAME>_PASSWORD=...` to the file themselves, or to run
  `npx -y -p mcp-ssh-manager ssh-manager server add`, which asks for it in their
  own terminal.
- **Offer a safety mode** for servers that matter. `SSH_SERVER_<NAME>_MODE=readonly`
  refuses every tool that changes the server; `restricted` allows only commands
  matching `SSH_SERVER_<NAME>_ALLOW_PATTERNS`. The default, `unrestricted`, allows
  everything. See `docs/SECURITY_MODES.md`.
- **Do not overwrite** an existing `~/.ssh-manager/.env`: it may already hold the
  user's servers. Append to it, and leave existing blocks as they are.

The first connection to a host records its key in `~/.ssh/known_hosts` (trust on
first use); later connections are refused if the key changes.

## 4. Restart and check

Restart the MCP server in the client (for Cline: the restart button next to
`ssh-manager` in *MCP Servers*) so it reads the file, then:

1. Call `ssh_list_servers`. Each server written above must be listed.
2. Call `ssh_execute` with `{"server": "production", "command": "uptime"}` (use
   the user's server name). A result with an exit code of 0 means the setup works.

If the server is missing from the list, check the variable names in the file. If
the connection is refused, check the key path, the user name and the port with the
user; `Permission denied` usually means the key is not authorised on the server.

## Optional

- **Desktop application**: the same engine with an interface (approvals, live
  output, a terminal, a file browser), no Node.js needed. Downloads:
  https://github.com/bvisible/mcp-ssh-manager/releases/latest
- **Credentials in an encrypted vault** instead of the `.env`, and the full list of
  options (jump hosts, groups, sudo, TOML configuration): see the `README.md`.
