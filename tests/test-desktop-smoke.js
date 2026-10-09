import assert from 'node:assert/strict';
import { terminalSmokeCommand, verifyLocalTerminalSmoke } from '../desktop/electron/smoke-test.mjs';

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
