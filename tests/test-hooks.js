#!/usr/bin/env node

// Behavioural test for the hooks system.
//
// Two defects drive most of what is below.
//
// GHSA-759m-wfpq-xmx3: up to 3.8.5, context values were spliced raw into the
// text of a shell command, and the default `on-error` hook put the connection
// error inside double quotes. A server chooses that text (SSH_MSG_DISCONNECT
// carries a description of its choosing, before any key exchange), so
// `Bye $(touch …)` ran on the machine running the MCP server. Every case here
// that plants a canary must leave it absent; each fails if values go back to
// being spliced into the command text.
//
// Issue #87: hook settings were written inside the installed package (lost on
// upgrade, a write into the install directory) and the default log landed in
// the working directory, which under an MCP client is the user's open project.
// Settings now live in SSH_MANAGER_HOME, nothing is written until something
// changes, and logs never touch the working directory.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-hooks-'));
const home = path.join(sandbox, 'home');
const cwd = path.join(sandbox, 'project');
fs.mkdirSync(cwd);
process.env.SSH_MANAGER_HOME = home;
process.chdir(cwd);

const {
  initializeHooks, loadHooksConfig, executeHook, addHook, removeHook, toggleHook, listHooks,
  renderShellCommand, renderCmdCommand,
} = await import('../src/hooks-system.js');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const posix = process.platform !== 'win32';
const canary = path.join(sandbox, 'PWNED');
const payloads = [
  `Bye $(touch ${canary})`,
  `Bye \`touch ${canary}\``,
  `Bye "; touch ${canary}; echo "`,
  `Bye '; touch ${canary}; echo '`,
  `Bye \\"; touch ${canary} #`,
];
const mode = file => fs.statSync(file).mode & 0o777;
const legacyFile = path.join(ROOT, '.hooks-config.json');
const legacyBackup = fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile) : null;

// 3.8.5 created an empty hooks/ directory in the package on every start; an
// old checkout may still have one. rmdir only ever removes it while empty.
try { fs.rmdirSync(path.join(ROOT, 'hooks')); } catch { /* absent or not empty */ }

try {
  // --- Nothing is written until something changes -------------------------
  await initializeHooks();
  const config = loadHooksConfig();
  listHooks();
  assert.equal(fs.existsSync(home), false, 'loading hooks must not create the manager home');
  assert.equal(fs.existsSync(path.join(ROOT, 'hooks')), false, 'no hooks/ directory inside the package');
  assert.deepEqual(fs.readdirSync(cwd), [], 'nothing in the working directory');
  ok('initializing and loading hooks writes nothing, anywhere');

  const onError = config['on-error'];
  assert.equal(onError.enabled, true, 'on-error stays on by default');
  assert.deepEqual(onError.actions.map(a => a.type), ['log'], 'the default on-error hook involves no shell');
  ok('the default on-error hook is a log action, not a shell command');

  // --- GHSA-759m: the attack from the advisory -------------------------------
  // Without a manager home the log is skipped rather than creating one.
  await executeHook('on-error', { server: 'victim', error: payloads[0] });
  assert.equal(fs.existsSync(canary), false, 'the disconnect text must not run');
  assert.equal(fs.existsSync(home), false, 'a log is no reason to create the home');
  assert.deepEqual(fs.readdirSync(cwd), [], 'no errors.log in the working directory');
  ok('on-error with a hostile disconnect text and no manager home: nothing runs, nothing written');

  fs.mkdirSync(home, { mode: 0o700 });
  for (const error of [...payloads, 'line one\n[2026-01-01T00:00:00.000Z] Error on forged: entry']) {
    await executeHook('on-error', { server: 'victim', error });
  }
  assert.equal(fs.existsSync(canary), false, 'no payload may run');
  const errorsLog = path.join(home, 'errors.log');
  const lines = fs.readFileSync(errorsLog, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, payloads.length + 1, 'one line per error: a newline cannot forge an entry');
  assert.ok(lines[0].endsWith(`Error on victim: ${payloads[0]}`), 'the text is recorded literally');
  if (posix) assert.equal(mode(errorsLog), 0o600, 'errors.log is readable by its owner only');
  assert.deepEqual(fs.readdirSync(cwd), [], 'still nothing in the working directory');
  ok('on-error logs hostile text literally to SSH_MANAGER_HOME/errors.log (0600), one line each');

  // --- Settings live in the manager home -----------------------------------
  addHook('custom', { enabled: true, description: 'Custom', actions: [] });
  const hooksFile = path.join(home, 'hooks.json');
  assert.ok(loadHooksConfig().custom, 'an added hook is loaded back');
  if (posix) assert.equal(mode(hooksFile), 0o600, 'hooks.json is readable by its owner only');
  toggleHook('custom', false);
  assert.equal(loadHooksConfig().custom.enabled, false);
  toggleHook('custom', true);
  assert.equal(loadHooksConfig().custom.enabled, true);
  removeHook('custom');
  assert.equal(loadHooksConfig().custom, undefined);
  assert.equal(fs.existsSync(legacyFile) && !legacyBackup, false, 'nothing written inside the package');
  ok('add, toggle and remove persist in SSH_MANAGER_HOME/hooks.json (0600), not in the package');

  toggleHook('on-error', false);
  assert.equal(loadHooksConfig()['on-error'].enabled, false);
  assert.equal(listHooks().find(h => h.name === 'on-error').enabled, false);
  fs.rmSync(hooksFile);
  assert.equal(loadHooksConfig()['on-error'].enabled, true, 'a toggle never mutates the in-memory defaults');
  ok('disabling on-error is remembered, and the defaults in memory stay untouched');

  addHook('disabled-test', { enabled: false, description: 'Off', actions: [{ type: 'notification', name: 'x', command: `touch ${canary}` }] });
  const skipped = await executeHook('disabled-test', {});
  assert.equal(skipped.skipped, true);
  assert.equal(fs.existsSync(canary), false);
  removeHook('disabled-test');
  ok('a disabled hook is skipped');

  // --- Local command hooks ---------------------------------------------------
  if (posix) {
    const out = path.join(sandbox, 'out.txt');
    const templates = [
      `echo "server={server} error={error}" > ${out}`,
      `echo server={server} error={error} > ${out}`,
      `echo 'server={server} error={error}' > ${out}`,
      `echo "$(echo "server={server}") $(echo error={error})" > ${out}`,
      `cat > ${out} <<EOF\nserver={server} error={error}\nEOF`,
      `cat > ${out} <<'EOF'\nserver={server} error={error}\nEOF`,
      `cat > ${out} <<-EOF\n\t\tserver={server} error={error}\n\tEOF`,
    ];
    for (const template of templates) {
      for (const error of payloads) {
        addHook('render', { enabled: true, description: 'Render', actions: [{ type: 'notification', name: 'render', command: template }] });
        const result = await executeHook('render', { server: 'prod', error });
        assert.equal(result.success, true, `hook failed for ${template}`);
        assert.equal(fs.existsSync(canary), false, `injection through ${JSON.stringify(template)} with ${error}`);
        assert.equal(fs.readFileSync(out, 'utf8').trim(), `server=prod error=${error}`,
          `value not delivered intact through ${JSON.stringify(template)}`);
      }
    }
    // A value cut into lines must not end a heredoc early, quoted or not.
    for (const template of templates.slice(-3)) {
      addHook('render', { enabled: true, description: 'Render', actions: [{ type: 'notification', name: 'render', command: template }] });
      await executeHook('render', { server: 'prod', error: `x\nEOF\ntouch ${canary}\n\tEOF\ntouch ${canary}` });
      assert.equal(fs.existsSync(canary), false, `a multi-line value escaped ${JSON.stringify(template)}`);
    }
    removeHook('render');
    ok(`local command hooks: ${templates.length} quoting contexts × ${payloads.length} payloads, values intact, nothing run`);

    const vars = renderShellCommand('notify {backupId} {missing} ${HOME} {server}', { backupId: 'b-1', server: 's', obj: {} });
    assert.equal(vars.command, 'notify "${SSH_MANAGER_HOOK_BACKUP_ID}" {missing} ${HOME} "${SSH_MANAGER_HOOK_SERVER}"');
    assert.deepEqual(vars.values, { SSH_MANAGER_HOOK_BACKUP_ID: 'b-1', SSH_MANAGER_HOOK_SERVER: 's' });
    ok('placeholders become SSH_MANAGER_HOOK_* variables; unknown ones and ${VAR} are left alone');

    // --- Remote command hooks ------------------------------------------------
    // The remote side is a POSIX shell too: run what would be sent, locally.
    let sent = null;
    const sshConnection = { execCommand: async (command) => { sent = command; return { stdout: '', stderr: '', code: 0 }; } };
    for (const error of payloads) {
      addHook('remote', { enabled: true, description: 'Remote', actions: [{ type: 'notification', name: 'r', remoteCommand: 'echo "server={server} error={error}"' }] });
      await executeHook('remote', { server: 'prod', error, sshConnection });
      const stdout = execFileSync('/bin/sh', ['-c', sent], { encoding: 'utf8' });
      assert.equal(stdout.trim(), `server=prod error=${error}`);
      assert.equal(fs.existsSync(canary), false, `remote injection with ${error}`);
    }
    addHook('remote', { enabled: true, description: 'Remote', actions: [{ type: 'notification', name: 'r', remoteCommand: 'bench --site all clear-cache' }] });
    await executeHook('remote', { server: 'prod', sshConnection });
    assert.equal(sent, 'bench --site all clear-cache', 'a command without placeholders is sent unchanged');
    removeHook('remote');
    ok('remote command hooks carry values as shell variables, and plain commands go out unchanged');
  }

  const cmd = renderCmdCommand('echo {error} & echo "{server}"', { error: 'a & del x | y %PATH% ^!', server: 'p"q' });
  assert.equal(cmd, 'echo "a _ del x _ y _PATH_ __" & echo "p_q"');
  ok('cmd.exe rendering strips every character cmd treats specially');

  // --- The pre-4.0 file is still read, never written -------------------------
  fs.rmSync(hooksFile, { force: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ 'legacy-hook': { enabled: true, description: 'Old', actions: [] } }));
  assert.ok(loadHooksConfig()['legacy-hook'], 'a source checkout keeps its old hooks');
  toggleHook('legacy-hook', false);
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf8'))['legacy-hook'].enabled, false, 'the change lands in the home');
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8'))['legacy-hook'].enabled, true, 'the old file is left as it was');
  ok('the pre-4.0 .hooks-config.json is read until the first change, which writes hooks.json');
} finally {
  if (legacyBackup) fs.writeFileSync(legacyFile, legacyBackup);
  else fs.rmSync(legacyFile, { force: true });
  process.chdir(ROOT);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n✅ hooks tests passed (${passed} checks)`);
