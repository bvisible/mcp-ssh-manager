---
name: ssh-incident
description: |
  A diagnosis order for "the server is down", "the site is slow", "something
  broke". Use when investigating a problem on a remote server through the ssh_*
  tools, before changing anything.
---

# Diagnosing before touching

The instinct under pressure is to restart something. Resist it for four calls:
a restart that fixes the symptom destroys the evidence, and you will be back
tomorrow.

## The order, and why it is this order

**1. `ssh_health_check`** — one call, and it answers most incidents outright.
A full disk, memory exhaustion and a load spike all look like "the site is down"
from outside. Start here every time.

**2. `ssh_service_status`** on the services that matter — the web server, the
database, the app. "Active" with a recent start time means something restarted
it; that is a clue, not a resolution.

**3. `ssh_tail`** on the relevant log, with `follow: false` so you get the last
lines back rather than a stream. The error is usually in there, in plain text,
and reading it takes ten seconds. Guessing takes an hour.

**4. `ssh_process_manager`** to list processes when the health check pointed at
CPU or memory. Find what is eating the machine before deciding what to do about
it.

Only now consider changing something.

## Things that are true more often than they should be

- **A full disk presents as everything being broken.** Logs cannot be written,
  databases refuse writes, uploads fail. Check `disk` in the health output first,
  and look at `/var/log` before blaming the application.
- **"It worked yesterday" usually means something rotated, filled, or expired.**
  A log that stopped rotating, a certificate, a token, a disk crossing 100%.
- **A service that is running is not a service that is working.** `active
  (running)` and a port nobody answers on are entirely compatible.
- **Check whether it is only you.** A network path, a DNS entry or a firewall
  rule can make one machine look dead from where you are and fine from elsewhere.

## What not to do

- Do not restart a service before reading its logs. You lose the reason.
- Do not clear a log file to free disk space without looking at it first; move it
  aside if you must, and let the service reopen its handle.
- Do not run a fix on every server in a group because it worked on one. Confirm
  the same symptom is there first.
- Do not report "fixed" when you restarted something and the symptom went away.
  Say what you found and what you did — if you did not find a cause, say that too.
