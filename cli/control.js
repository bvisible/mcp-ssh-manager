#!/usr/bin/env node
// `ssh-manager control` — run the control plane.
//
// Starts the approval socket the engine talks to and a local page to watch and
// decide on. Runs in the foreground: closing it takes the control plane away,
// and the engine goes back to deciding on its own.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ControlPlane } from '../src/control-plane.js';
import { defaultSocketPath } from '../src/approval.js';
import { ConfigLoader } from '../src/config-loader.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Audit logs to follow: whatever the configured servers write.
 * @returns {Promise<string[]>} Distinct existing-or-future audit paths
 */
async function discoverAuditPaths() {
  try {
    const loader = new ConfigLoader();
    const servers = await loader.load();
    return [...new Set([...servers.values()].map(s => s.auditLog).filter(Boolean))];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : 0;

  const socketPath = defaultSocketPath();
  const auditPaths = await discoverAuditPaths();

  const plane = new ControlPlane({ socketPath, port, auditPaths });
  const { url } = await plane.start();

  console.log(`
${GREEN}${BOLD}Control plane running${RESET}

  ${BOLD}Open:${RESET}   ${url}
  ${DIM}Socket: ${socketPath}${RESET}
  ${DIM}Audit:  ${auditPaths.length ? auditPaths.join(', ') : 'no server has AUDIT_LOG set — the timeline will only show approvals'}${RESET}

${DIM}The link carries a one-time token for this run. It approves commands on your
servers, so treat it like a password: do not paste it anywhere.

Servers with APPROVAL=destructive or =always will now pause here for a decision.
Close this process and they go back to running unattended.${RESET}
`);

  if (auditPaths.length === 0) {
    console.log(`${YELLOW}Tip:${RESET} set ${BOLD}SSH_SERVER_<NAME>_AUDIT_LOG=/path/to/audit.jsonl${RESET} to see everything, not just approvals.\n`);
  }

  // A control plane outliving whatever launched it is worse than none: it keeps
  // the approval socket, so agents block on a UI nobody can see. When the parent
  // dies the process is reparented to init, so a changed ppid is the signal.
  //
  // Only when launched by another program: interactively, `nohup` and friends
  // reparent on purpose and the user means it. (stdin was the first attempt and
  // was wrong — resume() on an empty pipe fires 'end' immediately, which killed
  // the control plane the moment the desktop app started it.)
  if (!process.stdin.isTTY) {
    const parentPid = process.ppid;
    const watcher = setInterval(() => {
      if (process.ppid !== parentPid) {
        console.log('\nParent process gone — stopping.');
        clearInterval(watcher);
        shutdown();
      }
    }, 2000);
    watcher.unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function shutdown() {
    console.log('\nStopping — pending requests will be refused.');
    await plane.stop();
    process.exit(0);
  }
}

main().catch(error => {
  console.error(`Failed to start the control plane: ${error.message}`);
  if (error.code === 'EADDRINUSE') {
    console.error('Another control plane is already running, or a stale socket is in the way.');
  }
  process.exit(1);
});
