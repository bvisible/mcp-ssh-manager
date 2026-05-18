#!/usr/bin/env node
/**
 * End-to-end policy + audit test against a real SSH server.
 *
 * This script is fully generic — it reads its target from environment
 * variables and does not hardcode any host. It exercises the v3.5.0
 * policy code paths (unrestricted / readonly / restricted) and the
 * audit log writer.
 *
 * Usage:
 *   SSH_E2E_HOST=host.example.com \
 *   SSH_E2E_USER=tester \
 *   SSH_E2E_PASSWORD=secret \
 *   node debug/test-e2e-policy.js
 *
 * Alternative auth (SSH key):
 *   SSH_E2E_HOST=host.example.com \
 *   SSH_E2E_USER=tester \
 *   SSH_E2E_KEYPATH=~/.ssh/id_ed25519 \
 *   [SSH_E2E_PASSPHRASE=...] \
 *   node debug/test-e2e-policy.js
 *
 * Optional:
 *   SSH_E2E_PORT=22
 *
 * The test requires write access to /tmp on the remote host (one tiny
 * file is created and cleaned up on exit). The audit log is written
 * locally to /tmp and removed at the end of the run.
 *
 * What it asserts:
 *  - SSH layer not broken by v3.5.0 (real exec returns the expected user)
 *  - unrestricted mode is a strict no-op (every sample tool allowed,
 *    no audit file created when AUDIT_LOG is absent)
 *  - readonly mode blocks rm via the built-in denylist, blocks
 *    ssh_upload and ssh_execute_sudo at the tool level, and the target
 *    file truly survives on the remote (refusal is real, not silent)
 *  - restricted mode enforces ALLOW with DENY-wins precedence
 *  - audit JSONL is well-formed, has the required fields, records
 *    denial reasons and execution exit codes
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import SSHManager from '../src/ssh-manager.js';
import { evaluatePolicy, _clearCompiledCache } from '../src/policy.js';
import { auditLog, _resetWarnedPaths } from '../src/audit.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', N = '\x1b[0m', C = '\x1b[36m';

let passed = 0, failed = 0;
function ok(msg) { console.log(`${G}✓${N} ${msg}`); passed++; }
function fail(msg, err) { console.log(`${R}✗${N} ${msg}\n  ${R}${err}${N}`); failed++; }
function section(msg) { console.log(`\n${C}━━ ${msg} ━━${N}`); }

const HOST = process.env.SSH_E2E_HOST;
const USER = process.env.SSH_E2E_USER;
const PORT = parseInt(process.env.SSH_E2E_PORT || '22');
const PASSWORD = process.env.SSH_E2E_PASSWORD;
const KEYPATH = process.env.SSH_E2E_KEYPATH;
const PASSPHRASE = process.env.SSH_E2E_PASSPHRASE;

if (!HOST || !USER || (!PASSWORD && !KEYPATH)) {
  console.error(`${R}Missing required env vars.${N}`);
  console.error('Required: SSH_E2E_HOST, SSH_E2E_USER, and either SSH_E2E_PASSWORD or SSH_E2E_KEYPATH');
  console.error('See the file header for full usage.');
  process.exit(2);
}

const AUDIT_PATH = `/tmp/ssh-audit-e2e-${process.pid}.jsonl`;
const REMOTE_TEST_FILE = `/tmp/policy-test-${process.pid}`;

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function makeConfig(name, mode, extra = {}) {
  return {
    name,
    host: HOST,
    user: USER,
    password: PASSWORD,
    keyPath: expandHome(KEYPATH),
    passphrase: PASSPHRASE,
    port: PORT,
    mode,
    allowPatterns: extra.allowPatterns || [],
    denyPatterns: extra.denyPatterns || [],
    auditLog: extra.auditLog,
    source: 'e2e-test',
  };
}

// One real connection, reused across all modes. The unrestricted smoke test
// proves it works end-to-end; subsequent mode tests reuse it for actual SSH
// execution (policy is evaluated in-process before each call).
const sharedConfig = makeConfig('e2e_shared', 'unrestricted');
const sharedSSH = new SSHManager(sharedConfig);

async function exitWith(code) {
  if (fs.existsSync(AUDIT_PATH)) {
    fs.unlinkSync(AUDIT_PATH);
    console.log(`${Y}(cleaned up ${AUDIT_PATH})${N}`);
  }
  try {
    if (sharedSSH.connected) {
      await sharedSSH.execCommand(`rm -f ${REMOTE_TEST_FILE}`, { timeout: 5000 }).catch(() => {});
      sharedSSH.dispose();
    }
  } catch {}
  process.exit(code);
}

process.on('SIGINT', () => exitWith(130));

async function main() {
  console.log(`${Y}E2E policy test against ${USER}@${HOST}:${PORT}${N}`);
  console.log(`${Y}Audit log: ${AUDIT_PATH}${N}\n`);

  // ── 1. SSH connectivity smoke test ─────────────────────────────────────────
  section('Smoke: SSH layer not broken by v3.5.0 changes');
  try {
    await sharedSSH.connect();
    const r = await sharedSSH.execCommand('whoami', { timeout: 10000 });
    if (r.stdout.trim() === USER) {
      ok(`SSH connect + execCommand returns expected user ("${r.stdout.trim()}")`);
    } else {
      fail('whoami output mismatch', `expected "${USER}", got "${r.stdout.trim()}"`);
    }
  } catch (err) {
    fail('SSH connect failed', err.message);
    return exitWith(1);
  }

  // ── 2. unrestricted: backward-compat fast path ─────────────────────────────
  section('Mode: unrestricted (backward-compat — must behave like v3.4.x)');
  const cfgUnr = makeConfig('e2e_unrestricted', 'unrestricted');
  for (const [tool, command] of [
    ['ssh_execute', 'ls /tmp'],
    ['ssh_execute', 'rm /tmp/nonexistent-policy-test-xyz'],
    ['ssh_execute_sudo', 'whoami'],
    ['ssh_upload', null],
    ['ssh_deploy', null],
  ]) {
    const r = evaluatePolicy(cfgUnr, tool, command);
    if (r.allowed) ok(`unrestricted → ${tool}${command ? ` ("${command}")` : ''} allowed`);
    else fail(`unrestricted blocked ${tool} — should never happen`, r.reason);
  }
  if (!fs.existsSync(AUDIT_PATH)) ok('No audit file created (AUDIT_LOG not set)');
  else fail('Audit file was created without AUDIT_LOG', 'leak');

  // ── 3. readonly: real exec against target ──────────────────────────────────
  section('Mode: readonly');
  _resetWarnedPaths();
  const cfgRo = makeConfig('e2e_readonly', 'readonly', { auditLog: AUDIT_PATH });

  async function tryExec(serverConfig, toolName, command) {
    const policy = evaluatePolicy(serverConfig, toolName, command);
    if (!policy.allowed) {
      auditLog(serverConfig, toolName, { command }, policy);
      return { allowed: false, reason: policy.reason };
    }
    const result = await sharedSSH.execCommand(command, { timeout: 10000 });
    auditLog(serverConfig, toolName, { command }, policy, {
      code: result.code,
      success: result.code === 0,
    });
    return { allowed: true, code: result.code, stdout: result.stdout };
  }

  {
    const r = await tryExec(cfgRo, 'ssh_execute', 'ls /tmp');
    if (r.allowed && r.code === 0) ok('readonly: "ls /tmp" allowed and executed (exit 0)');
    else fail('readonly: "ls /tmp" should pass', JSON.stringify(r));
  }

  {
    const r = await tryExec(cfgRo, 'ssh_execute', `echo policy-test > ${REMOTE_TEST_FILE}`);
    if (r.allowed && r.code === 0) ok(`readonly: "echo > ${REMOTE_TEST_FILE}" allowed (/tmp whitelisted)`);
    else fail('readonly: redirect to /tmp should pass', JSON.stringify(r));
  }

  {
    const r = await tryExec(cfgRo, 'ssh_execute', `rm ${REMOTE_TEST_FILE}`);
    if (!r.allowed && /rm/.test(r.reason)) ok(`readonly: "rm ${REMOTE_TEST_FILE}" refused (matched rm pattern)`);
    else fail('readonly: rm should be refused', JSON.stringify(r));
  }

  {
    const r = await sharedSSH.execCommand(`test -f ${REMOTE_TEST_FILE} && echo PRESENT || echo ABSENT`, { timeout: 5000 });
    if (r.stdout.trim() === 'PRESENT') ok('readonly: target file still present on remote (rm truly refused)');
    else fail('Target file unexpectedly missing', `got "${r.stdout.trim()}"`);
  }

  {
    const policy = evaluatePolicy(cfgRo, 'ssh_upload');
    auditLog(cfgRo, 'ssh_upload', { localPath: '/dev/null', remotePath: '/tmp/x' }, policy);
    if (!policy.allowed) ok('readonly: ssh_upload refused at tool level');
    else fail('ssh_upload should be tool-blocked in readonly', JSON.stringify(policy));
  }

  {
    const policy = evaluatePolicy(cfgRo, 'ssh_execute_sudo', 'whoami');
    if (!policy.allowed) ok('readonly: ssh_execute_sudo refused at tool level');
    else fail('ssh_execute_sudo should be tool-blocked in readonly', JSON.stringify(policy));
  }

  // ── 4. restricted: ALLOW + DENY ────────────────────────────────────────────
  section('Mode: restricted');
  _clearCompiledCache();
  const cfgRestr = makeConfig('e2e_restricted', 'restricted', {
    allowPatterns: ['^ls ', '^cat /etc/hostname', '^echo '],
    denyPatterns: [' -rf', '/etc/passwd'],
    auditLog: AUDIT_PATH,
  });

  {
    const r = await tryExec(cfgRestr, 'ssh_execute', 'ls /tmp');
    if (r.allowed && r.code === 0) ok('restricted: "ls /tmp" allowed (matches ^ls )');
    else fail('restricted: ls should pass', JSON.stringify(r));
  }

  {
    const r = await tryExec(cfgRestr, 'ssh_execute', 'cat /etc/hostname');
    if (r.allowed && r.code === 0) ok('restricted: "cat /etc/hostname" allowed (matches ALLOW)');
    else fail('restricted: cat /etc/hostname should pass', JSON.stringify(r));
  }

  {
    const r = await tryExec(cfgRestr, 'ssh_execute', 'cat /etc/passwd');
    if (!r.allowed && /passwd/.test(r.reason)) ok('restricted: "cat /etc/passwd" refused by DENY');
    else fail('restricted: cat /etc/passwd should be denied', JSON.stringify(r));
  }

  {
    const r = await tryExec(cfgRestr, 'ssh_execute', 'df -h');
    if (!r.allowed && /ALLOW/.test(r.reason)) ok('restricted: "df -h" refused (no ALLOW match)');
    else fail('restricted: df should be refused', JSON.stringify(r));
  }

  // ── 5. audit log integrity ─────────────────────────────────────────────────
  section('Audit log integrity');
  if (!fs.existsSync(AUDIT_PATH)) {
    fail('Audit file was not created', `expected at ${AUDIT_PATH}`);
  } else {
    const raw = fs.readFileSync(AUDIT_PATH, 'utf8').trim();
    const lines = raw.split('\n');
    ok(`Audit file written with ${lines.length} JSONL lines`);

    let parsed = [];
    try {
      parsed = lines.map((l) => JSON.parse(l));
      ok('Every line is valid JSON');
    } catch (e) {
      fail('Audit JSONL parse error', e.message);
    }

    const required = ['ts', 'server', 'tool', 'args', 'allowed'];
    if (parsed.every((e) => required.every((f) => f in e))) {
      ok(`All entries have required fields: ${required.join(', ')}`);
    } else {
      fail('Some entries miss required fields', JSON.stringify(parsed[0]));
    }

    const denials = parsed.filter((e) => !e.allowed);
    if (denials.length >= 4) ok(`${denials.length} denial entries (≥4 expected)`);
    else fail('Not enough denials logged', `got ${denials.length}`);

    if (denials.every((e) => typeof e.reason === 'string' && e.reason.length > 0)) {
      ok('Every denial has a non-empty reason');
    } else {
      fail('Some denials missing reason', '');
    }

    const oks = parsed.filter((e) => e.allowed && typeof e.exitCode === 'number');
    if (oks.length >= 3) ok(`${oks.length} successful exec entries have exitCode (≥3 expected)`);
    else fail('Successful entries missing exitCode', `got ${oks.length}`);
  }

  console.log(`\n${Y}Results:${N}`);
  console.log(`  ${G}Passed: ${passed}${N}`);
  console.log(`  ${R}Failed: ${failed}${N}\n`);
  return exitWith(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${R}Unhandled error:${N}`, err);
  exitWith(2);
});
