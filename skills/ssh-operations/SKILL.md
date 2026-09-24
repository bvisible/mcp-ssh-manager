---
name: ssh-operations
description: |
  How to work on remote servers through MCP SSH Manager without breaking them.
  Use this whenever a task involves deploying, backing up, restarting services,
  or running commands on a server through the ssh_* tools — especially on
  anything named prod, production or live.
---

# Working on someone's servers

You have a shell on machines that matter. The person who gave you this access
cannot see what you are doing unless they have the control plane open. Behave
accordingly.

## Before you change anything

**Look first.** `ssh_health_check` returns CPU, memory, disk, uptime and an
overall status in one call. Reach for it before concluding that anything is
wrong — a "the site is down" report is often a full disk, and one call tells you.

**Back up before you overwrite.** `ssh_deploy` takes a backup by default; do not
turn that off to save time. Before a database import or a destructive migration,
`ssh_backup_create` first. A backup you did not need costs seconds; the one you
skipped costs the data.

**Check what you are about to replace.** `ssh_execute` with `ls -la`, `cat`, or
`systemctl status` before writing over a file or restarting a service. Read the
current state rather than assuming it.

## While you work

**One server at a time unless asked otherwise.** `ssh_execute_group` runs on
every member of a group; that is powerful and unforgiving. If the task says "the
web servers", confirm which machines that means before running anything on all
of them.

**Prefer the specific tool over a raw command.** `ssh_service_status` instead of
`systemctl status` parsed by hand, `ssh_db_query` instead of piping SQL into a
client, `ssh_tail` instead of `tail`. They parse the output properly, they are
covered by the security modes, and their arguments are shell-quoted.

**Never put a password in a command.** Servers can carry a configured sudo
password (`ssh_execute_sudo` uses it) and database credentials. Do not
interpolate secrets into a command line: they end up in the remote process list
and in logs.

## When something goes wrong

**Do not retry a destructive command that failed.** Find out why it failed
first. A failed `rm -rf` that you run again with `sudo` is how an incident
becomes an outage.

**Say what you did.** When you report back, name the servers you touched and the
commands that changed something. The person reading you may not have been
watching.

## What you cannot see

Servers can be in `readonly` or `restricted` mode, and actions can require a
human's approval. A refusal is not a bug and not something to work around — see
the `ssh-restricted` skill.
