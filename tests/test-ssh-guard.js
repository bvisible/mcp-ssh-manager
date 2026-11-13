// The opt-in Claude Code hook that refuses an ssh, scp, sftp or remote rsync run
// from an agent's shell (idea from fyq163's fork).
//
// What matters: it finds the connection however the command is dressed (a
// pipeline, sudo, bash -c, a command substitution, xargs), it leaves everything
// else alone (ssh-keygen, git, a word in an echo, `command -v ssh`), installing
// never loses a setting or another hook, and nothing is written unless asked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOOK_FILE_NAME, decide, findRawSsh, guardStatus, hookCommand, installGuard, removeGuard,
} from '../src/ssh-guard.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-guard-'));
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

try {
  // ── what it finds ─────────────────────────────────────────────────────────
  const found = [
    'ssh prod uptime', 'ssh -p 2222 -i ~/.ssh/key deploy@10.0.0.5 "ls -la /srv"', 'cd /tmp && ssh prod', 'echo hi | ssh prod cat',
    'ls; ssh prod', 'sudo ssh prod', 'sudo -u deploy ssh prod', 'env FOO=1 ssh prod', 'FOO=1 BAR=2 ssh prod', 'time ssh prod', 'nohup ssh prod &',
    'exec ssh prod', 'command ssh prod', '/usr/bin/ssh prod', 'bash -c "ssh prod uptime"', "sh -c 'cd /srv; ssh prod'", 'bash -lc "echo a && ssh prod"',
    'echo $(ssh prod hostname)', 'echo `ssh prod hostname`', 'echo "now: $(ssh prod date)"', 'xargs -I{} ssh {} uptime < hosts', 'xargs -n 1 ssh',
    'timeout 10 ssh prod', 'eval "ssh prod"', '(ssh prod)', '{ ssh prod; }', 'if true; then ssh prod; fi', 'for h in a b; do ssh $h uptime; done',
    'scp ./a.txt prod:/tmp/', 'scp -r prod:/var/log ./logs', 'sftp prod', 'ssh-copy-id prod', 'autossh -M 0 prod', 'mosh prod',
    'rsync -az ./site/ deploy@prod:/srv/site/', 'rsync -avz prod:/data ./data', 'rsync -e ssh ./a prod:/b', 'rsync -ae "ssh -p 22" ./a ./b', 'rsync --rsh=ssh ./a ./b',
    'ssh prod 2>&1', 'ssh prod > out.txt', "ssh prod 'cat /etc/os-release' | grep ID", 'ssh\\\n  prod', 'ls\nssh prod\nls',
  ];
  for (const command of found) assert.ok(findRawSsh(command), `should find: ${JSON.stringify(command)}`);
  ok(`${found.length} ways of opening an SSH connection are found`);

  const left = [
    'ls ~/.ssh', 'ssh-keygen -t ed25519 -f ./k', 'ssh-add -l', 'ssh-agent', 'git push origin main', 'git clone git@github.com:o/r.git',
    'echo "ssh prod"', "echo 'scp a prod:/b'", 'grep ssh /var/log/auth.log', 'cat ssh.log', 'man ssh', 'which ssh', 'command -v ssh', 'type ssh',
    'ssh -V', 'ssh -h', 'rsync -a ./a ./b', 'rsync a /tmp/b', 'rsync -av ./a rsync://mirror/x', 'rsync -av C:\\data ./d',
    'npm run ssh', 'printf "%s\\n" "ssh host"', '# ssh prod', 'echo done # ssh prod', 'ls && echo ok', '', '   ', 'curl https://example.com/ssh',
    'sudo apt install openssh-client', 'systemctl status ssh', 'ps aux | grep ssh', 'echo $(date)', 'echo "$(whoami)@host:path"',
  ];
  for (const command of left) assert.equal(findRawSsh(command), null, `should leave alone: ${JSON.stringify(command)}`);
  ok(`${left.length} commands that only mention ssh, or do something else, are left alone`);

  // ── the answer ────────────────────────────────────────────────────────────
  const bash = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  const denied = decide(bash('ssh prod uptime'));
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /ssh_execute/);
  assert.equal(decide(bash('ssh prod uptime'), 'ask').hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(decide(bash('ls')), null);
  assert.equal(decide({ tool_name: 'Read', tool_input: { command: 'ssh prod' } }), null, 'only the Bash tool is judged');
  assert.equal(decide({ tool_name: 'Bash', tool_input: {} }), null);
  assert.equal(decide(null), null);
  ok('the answer is a PreToolUse deny (or ask), only for the Bash tool');

  // ── installing ────────────────────────────────────────────────────────────
  const settings = path.join(scratch, 'claude', 'settings.json');
  const script = path.join(scratch, 'ssh-manager', 'hooks', HOOK_FILE_NAME);
  const other = { type: 'command', command: 'echo audit' };
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [other] }], Stop: [{ hooks: [other] }] } };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2));
  const before = fs.readFileSync(settings, 'utf8');

  assert.equal(guardStatus({ settingsFile: settings, script }).installed, false);
  assert.equal(fs.readFileSync(settings, 'utf8'), before, 'status changes nothing');

  installGuard({ settingsFile: settings, script, mode: 'deny' });
  let written = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(written.model, 'opus');
  assert.deepEqual(written.permissions, original.permissions);
  assert.deepEqual(written.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(written.hooks.PreToolUse[0], original.hooks.PreToolUse[0], 'another hook is untouched');
  assert.equal(written.hooks.PreToolUse.length, 2);
  assert.equal(written.hooks.PreToolUse[1].matcher, 'Bash');
  assert.equal(written.hooks.PreToolUse[1].hooks[0].command, hookCommand(script, 'deny'));
  assert.equal(fs.readFileSync(`${settings}.ssh-manager.bak`, 'utf8'), before, 'the file as it was is kept');
  assert.ok(fs.statSync(script).isFile());
  assert.deepEqual({ installed: true, mode: 'deny', scriptPresent: true }, (({ installed, mode, scriptPresent }) => ({ installed, mode, scriptPresent }))(guardStatus({ settingsFile: settings, script })));
  ok('install adds the hook, keeps every other setting and hook, and keeps a copy of the file as it was');

  installGuard({ settingsFile: settings, script, mode: 'ask' });
  written = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(written.hooks.PreToolUse.length, 2, 'a second install replaces, never duplicates');
  assert.equal(guardStatus({ settingsFile: settings, script }).mode, 'ask');
  assert.equal(fs.readFileSync(`${settings}.ssh-manager.bak`, 'utf8'), before, 'the copy stays the original');
  ok('installing again replaces the hook and changes the mode');

  // The installed copy is what Claude Code runs: feed it a payload for real.
  const run = command => spawnSync(process.execPath, [script, '--mode', 'deny'], { input: JSON.stringify(bash(command)), encoding: 'utf8' });
  const blocked = run('cd /srv && ssh prod');
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const passedThrough = run('git status');
  assert.equal(passedThrough.status, 0);
  assert.equal(passedThrough.stdout, '');
  const garbage = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
  ok('the copied script, run as Claude Code runs it, blocks, lets through and never fails on garbage');

  removeGuard({ settingsFile: settings, script });
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original, 'remove restores the settings exactly');
  assert.equal(guardStatus({ settingsFile: settings, script }).installed, false);
  assert.ok(fs.existsSync(script), 'the script stays unless asked');
  removeGuard({ settingsFile: settings, script, deleteScript: true });
  assert.ok(!fs.existsSync(script));
  ok('remove takes only its own hook out, to the byte, and deletes the script on request');

  const fresh = path.join(scratch, 'fresh', 'settings.json');
  installGuard({ settingsFile: fresh, script, mode: 'deny' });
  assert.ok(fs.existsSync(fresh) && !fs.existsSync(`${fresh}.ssh-manager.bak`));
  removeGuard({ settingsFile: fresh, script });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {}, 'nothing of ours is left behind');
  ok('with no settings file, install creates one and remove leaves it empty');

  const broken = path.join(scratch, 'broken.json');
  fs.writeFileSync(broken, '{ "hooks": ');
  assert.throws(() => installGuard({ settingsFile: broken, script }), /change it by hand/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ "hooks": ', 'an unreadable file is never rewritten');
  fs.writeFileSync(broken, JSON.stringify({ hooks: { PreToolUse: 'nope' } }));
  assert.throws(() => installGuard({ settingsFile: broken, script }), /not a list/);
  assert.throws(() => installGuard({ settingsFile: fresh, script, mode: 'allow' }), /mode must be/);
  ok('a file or a shape it does not understand is refused, untouched');

  // ── the command line ──────────────────────────────────────────────────────
  const home = path.join(scratch, 'home');
  const cli = (...args) => spawnSync(process.execPath, [path.join(repo, 'cli', 'guard.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), SSH_MANAGER_HOME: path.join(home, 'sm') },
  });
  const printed = cli('print');
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /Nothing was changed/);
  assert.ok(!fs.existsSync(home), 'print writes nothing at all');
  assert.match(cli('status').stdout, /Not installed/);
  assert.ok(!fs.existsSync(home), 'status writes nothing either');
  assert.match(cli('install', '--mode', 'ask').stdout, /mode: ask/);
  assert.match(cli('status').stdout, /Installed .* \(mode: ask\)/);
  assert.match(cli('remove', '--delete-script').stdout, /Removed/);
  assert.match(cli('remove').stdout, /Nothing to remove/);
  assert.equal(cli('install', '--mode', 'allow').status, 1);
  assert.equal(cli('frobnicate').status, 2);
  assert.match(cli('help').stdout, /not a security boundary/);
  ok('the command line: print and status write nothing, install and remove do what they say');

  console.log(`\n✅ ssh guard tests passed (${passed} checks)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
