import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalSmokeCommand, verifyLocalTerminalSmoke, verifyEngineAnswers } from '../desktop/electron/smoke-test.mjs';

function fixture(shell, response) {
  const data = [], exits = [];
  return { shell, killed: false, commands: [],
    onData(handler) { data.push(handler); },
    onExit(handler) { exits.push(handler); },
    kill() { this.killed = true; },
    write(bytes) {
      const command = bytes.toString(); this.commands.push(command);
      if (command === 'exit\r') { queueMicrotask(() => exits.forEach(handler => handler())); return; }
      queueMicrotask(() => data.forEach(handler => handler(response ?? command)));
    },
  };
}

for (const shell of ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash', 'zsh']) {
  assert.ok(!terminalSmokeCommand(shell).includes('SSH_RELEASE_SMOKE_OK'), `${shell}: the command must not echo the expected answer verbatim`);
  const echoOnly = fixture(shell);
  await assert.rejects(verifyLocalTerminalSmoke(echoOnly, { timeoutMs: 5 }), /did not return the command result/);
  assert.equal(echoOnly.killed, true);
  // ConPTY can place the output directly after a cursor move, with no LF
  // before it. This is the output rejected by the former plain-line regex.
  const working = fixture(shell, '\x1b[?25l\x1b[4;1HSSH_RELEASE_\x1b[0mSMOKE_OK\r\n\x1b[?25h');
  await verifyLocalTerminalSmoke(working, { timeoutMs: 100 });
  assert.equal(working.commands.at(-1), 'exit\r');
  assert.equal(working.killed, false, 'a healthy shell should exit normally');
}
console.log('✓ desktop smoke accepts VT command results for CMD, PowerShell and POSIX shells, rejects input echoes and exits normally');

// The engine an AI tool would start: this checkout's, as the application starts its own.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-engine-'));
const saved = { ...process.env };
Object.assign(process.env, { HOME: scratch, SSH_MANAGER_HOME: scratch, SSH_ENV_PATH: path.join(scratch, '.env'), SSH_CONFIG_PATH: path.join(scratch, 'absent.toml') });
try {
  const stages = [];
  await verifyEngineAnswers({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))], env: {} }, { stage: line => stages.push(line) });
  assert.match(stages[0], /application engine answered over MCP \(\d+ tools\)/);
  await assert.rejects(verifyEngineAnswers({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }), /exited 3 before answering initialize/);
} finally {
  for (const key of ['HOME', 'SSH_MANAGER_HOME', 'SSH_ENV_PATH', 'SSH_CONFIG_PATH']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log('✓ desktop smoke starts an engine as an AI tool would and reads its tools over MCP; an engine that dies is reported');
