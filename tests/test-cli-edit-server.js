import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-cli-edit-'));
const envPath = path.join(tmpDir, '.env');

function findBash() {
  if (process.platform !== 'win32') return 'bash';

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);

  const bash = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(bash, 'Git Bash is required to test the Bash CLI on Windows');
  return bash;
}

function toBashPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  assert.ok(match, `Expected an absolute Windows path, got: ${filePath}`);
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

try {
  fs.writeFileSync(
    envPath,
    [
      'SSH_SERVER_ALPHA_HOST=10.0.0.10',
      'SSH_SERVER_ALPHA_USER=alpha-user',
      'SSH_SERVER_ALPHA_PORT=22',
      'SSH_SERVER_ALPHA_KEYPATH=/tmp/alpha-key',
      '',
      '# Server: guacamole',
      'SSH_SERVER_GUACAMOLE_HOST=192.168.0.126',
      'SSH_SERVER_GUACAMOLE_USER=guac-user',
      'SSH_SERVER_GUACAMOLE_PORT=22',
      'SSH_SERVER_GUACAMOLE_KEYPATH=/tmp/guac-key',
      'SSH_SERVER_GUACAMOLE_DESCRIPTION="Guacamole test server"',
      'SSH_SERVER_GUACAMOLE_DEFAULT_DIR=/srv/guacamole',
      '',
    ].join('\n')
  );

  const bashRepoRoot = toBashPath(repoRoot);
  const bashEnvPath = toBashPath(envPath);
  const script = [
    `export SSH_MANAGER_ENV='${bashEnvPath}'`,
    'export TERM=dumb',
    `source '${bashRepoRoot}/cli/lib/colors.sh'`,
    `source '${bashRepoRoot}/cli/lib/config.sh'`,
    `source '${bashRepoRoot}/cli/lib/menu.sh'`,
    'wizard_edit_server',
  ].join('; ');

  const input = ['2', '192.168.0.127', '', '', '', '', '', 'y', 'n', ''].join('\n');
  const result = spawnSync(findBash(), ['-c', script], {
    encoding: 'utf8',
    input,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.strictEqual(result.status, 0, output);
  assert.match(output, /Server 'guacamole' updated successfully/);
  assert.doesNotMatch(output, /Server '' not found/);

  const updated = fs.readFileSync(envPath, 'utf8');
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_HOST=192\.168\.0\.127$/m);
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_USER=guac-user$/m);
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_PORT=22$/m);
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_KEYPATH=\/tmp\/guac-key$/m);
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_DESCRIPTION="Guacamole test server"$/m);
  assert.match(updated, /^SSH_SERVER_GUACAMOLE_DEFAULT_DIR=\/srv\/guacamole$/m);

  console.log('✅ interactive edit updates the selected server and preserves unchanged values');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
