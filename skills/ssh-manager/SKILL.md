---
name: ssh-manager
description: |
  How to use the MCP SSH Manager core tools (ssh_list_servers, ssh_execute, ssh_upload,
  ssh_download, ssh_sync) without breaking a server: server names, the remote shell, time
  limits and long commands, file transfer pitfalls, security modes, host keys. Use it whenever
  a task runs a command or moves a file on a remote machine through these tools.
---

# Using the SSH Manager tools

This skill covers the five **core** tools, the ones exposed in the default `minimal` mode. If
more groups are enabled (`ssh-manager tools list`), prefer the specific tool over a raw command.

| Tool | What it does | Changes the server? |
|---|---|---|
| `ssh_list_servers` | Lists configured servers: name, host, user, port, auth type, default directory, group. Never returns secrets. | no |
| `ssh_execute` | Runs one command line, returns `stdout`, `stderr`, `code`. | depends on the command |
| `ssh_upload` | Copies ONE local file over SFTP, overwriting the target. No backup, no sudo. | yes |
| `ssh_download` | Copies ONE remote file to a local path (overwrites the local file). | no |
| `ssh_sync` | rsync over SSH. One side `local:`, the other `remote:`. `dryRun` previews, `delete` removes extras at the destination. | yes |

## Before the first command

- Call `ssh_list_servers` once and use the exact names. A name is lowercase and every character
  that is not a letter or a digit became `_` (`my-site.ch` → `my_site_ch`). Several names can
  share one host with different users: take the user with the rights you need and no more.
- `ssh_execute` runs `cd -- '<cwd, or the server's default directory>' && <your command>`.
  Pass `cwd` when the default is wrong. A missing directory fails the whole call.
- A server can be in `readonly` mode (destructive commands and uploads refused) or `restricted`
  mode (only commands matching its patterns). A refusal is the configuration working: do not
  look for a way around it, ask whoever owns the server.

## Writing the command

- Assume the remote shell is `sh`/`dash`, not bash: no `<(…)`, no `[[ … ]]`, no arrays, no
  `{a,b}`, no `$'…'`. A syntax error aborts the whole line **before any part of it ran**. Pipe
  instead, or wrap in `bash -c '…'`.
- Heredocs work (`<<'EOF'`). Quote the delimiter so nothing is expanded by the remote shell.
- Chain with `&&` when step two must not run after a failure.
- `pgrep -f` and `pkill -f` match every command line, including the shell that carries your
  command. Bracket one letter (`pgrep -f '[n]ginx -g'`) and kill in one call, relaunch in the next.
- Never put a password or token in the command line: it ends up in the remote process list and in
  logs. Use a file with mode 600 or an environment variable set on the remote side.

## Time limits and long commands

- Default timeout 120 s, maximum 300 s (`timeout`, in ms). In practice a call can be cut after
  about three minutes. A command killed halfway leaves its work half done.
- Anything long or that restarts a service (builds, migrations, big copies, restarts): start it
  detached and poll with short calls.
  `setsid nohup <command> > ~/job.log 2>&1 &` then `tail -n 20 ~/job.log`.
  Never run a service restart straight inside `ssh_execute`: if the call is cut, the restart stops
  halfway and workers stay stopped.
- `ssh_sync` has its own timeout, 30 s by default: raise it for a big tree.

## Moving files

- `ssh_upload` replaces the target completely. On a directory other people edit (a shared git tree),
  never upload a whole file over an existing one: you silently revert what changed in it since
  your copy. Apply a targeted edit on the remote, or upload to your own directory.
- For trees, run `ssh_sync` with `dryRun: true` first and read the list. Never `delete: true`
  without having read it.
- To read a big file (a log, a dump), `ssh_download` it instead of `cat` inside `ssh_execute`.

## Host keys and secrets

- Hosts are checked against `known_hosts`: a changed key is refused. A rebuilt server legitimately
  changes its key, but never accept it blindly: compare the new key seen from two machines
  (`ssh-keyscan` from yours and from another trusted host), then replace the old line.
- Prefer key authentication. Password servers need `sshpass` locally for `ssh_sync`.
- The configuration file (`~/.ssh-manager/.env`) holds passwords and key paths: never print it
  and never paste it in a message.

## Good habits

- Look before you change (`ls -la`, `git status`, `systemctl status`) and use read-only calls to find
  out what is wrong before restarting anything.
- Do not retry a destructive command that failed until you know why it failed.
- When you report back, name the servers you touched and the commands that changed something.
