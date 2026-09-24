---
name: ssh-restricted
description: |
  What to do when an ssh_* tool refuses to run: security modes (readonly,
  restricted) and human approval. Use when a command is denied, refused, or
  seems to hang waiting for something.
---

# When a server says no

MCP SSH Manager lets an operator constrain what an agent may do, per server.
A refusal is the system working, not a bug to route around.

## The three answers you can get

**"Policy denied: Tool X is disabled (mode: readonly)"** — the server is
read-only. Mutating tools (`ssh_deploy`, `ssh_upload`, `ssh_execute_sudo`,
`ssh_backup_restore`, `ssh_db_import`…) are off entirely. Reading still works.

**"Policy denied: ... matches built-in destructive pattern"** or **"does not
match the allow patterns"** — the server is `restricted`. The operator listed
what may run there, and this is not on the list.

**"Refused by the operator"** — a human saw the command in the control plane and
said no. That is a person, not a rule.

## What to do about it

**Say what was refused and why, plainly.** The operator configured this on
purpose; they need to know their agent hit the wall, not that "something went
wrong".

**Offer the read-only equivalent.** Refused `systemctl restart nginx`? You can
still `ssh_service_status`, `ssh_tail` the error log, and report what you found
along with the exact command a human would need to run. That is usually more
useful than the restart would have been.

**Do not look for a way around it.** Do not:

- retry the same thing through `ssh_execute` because the specific tool was
  blocked — the policy layer covers both;
- reach for another server that is less constrained to do the same work;
- ask the user to disable the mode so you can continue. If they want it off,
  they will say so.

Working around a control someone deliberately put in place is worse than failing
the task, because they will believe it held.

## Approval, and waiting

When a server is set to `destructive` or `always` approval, the engine pauses and
asks a human before running. From your side the call simply takes longer — that
is expected, and it is what the operator wanted.

If it comes back **"Refused by the operator"**, do not run a variation of the
same command hoping it slips through. Report the refusal and ask what they would
prefer instead.
