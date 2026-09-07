import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { shellPath } from '../src/shell-quote.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-cwd-'));
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
const { default: SSHManager } = await import('../src/ssh-manager.js');
try {
  const paths = ['/a directory/with spaces', "/quotes'and\"marks", '/literal/$variable; & | brackets[]', '-leading-dash'];
  if (process.platform !== 'win32') {
    for (const value of paths) {
      const actual = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellPath(value)}`], { encoding: 'utf8' });
      assert.equal(actual, value);
    }
    assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellPath('~/folder with spaces')}`], { encoding: 'utf8' }), `${process.env.HOME}/folder with spaces`);
  }
  const ssh = new SSHManager({ name: 'fixture', host: 'fixture.invalid', user: 'fixture' });
  ssh.connected = true;
  let sent;
  ssh.client = new EventEmitter();
  ssh.client.exec = (command, callback) => {
    sent = command;
    const stream = new PassThrough(); stream.stderr = new PassThrough();
    callback(null, stream);
    queueMicrotask(() => stream.emit('close', 0));
  };
  const cwd = paths[2];
  await ssh.execCommand('printf fixture', { cwd });
  assert.equal(sent, `cd -- ${shellPath(cwd)} && printf fixture`);
  assert.equal(shellPath('~'), '"$HOME"');
  console.log('✓ working directory spaces and shell characters stay literal; ~/ still expands; SSHManager sends one quoted cd argument');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
