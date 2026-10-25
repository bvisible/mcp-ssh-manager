import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { suggestDesktop } from '../cli/experience.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-v4-'));
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
try {
  let output = '';
  const options = { stdin: { isTTY: true }, stderr: { isTTY: true, write: text => { output += text; } }, env: { SSH_MANAGER_HOME: scratch } };
  for (const args of [['--version'], ['--help'], ['server', 'list'], ['control'], ['vault', 'list'], ['app'], ['app', '--status']]) {
    assert.equal(suggestDesktop(args, options), false);
  }
  assert.equal(output, '');
  assert.deepEqual(fs.readdirSync(scratch), []);
  assert.equal(suggestDesktop([], { ...options, stdin: { isTTY: false } }), false);
  assert.equal(suggestDesktop([], { ...options, env: { ...options.env, CI: 'true' } }), false);
  assert.equal(suggestDesktop([], { ...options, env: { ...options.env, SSH_MANAGER_NO_TIPS: '1' } }), false);
  assert.equal(suggestDesktop([], options), true);
  assert.match(output, /ssh-manager control/);
  assert.match(output, /ssh-manager app/, 'the invitation points to the command that installs the app');
  assert.doesNotMatch(output, /releases/, 'not to a page where a file has to be picked by hand');
  assert.match(output, /interface is optional/);
  const once = output;
  assert.equal(suggestDesktop([], options), false);
  assert.equal(output, once);

  const versionRun = spawnSync(process.execPath, ['cli/ssh-manager.js', '--version'], { encoding: 'utf8', env: { ...process.env, SSH_MANAGER_HOME: scratch } });
  assert.equal(versionRun.status, 0);
  assert.ok(versionRun.stdout.includes(`SSH Manager CLI v${version}`));
  assert.equal(versionRun.stderr, '');
  console.log('CLI compatibility: direct commands/pipes/CI stay silent; desktop invitation points to `ssh-manager app` and is shown once.');

  if (process.platform !== 'win32') {
    const home = path.join(scratch, 'home');
    const managerHome = path.join(home, '.ssh-manager');
    fs.mkdirSync(managerHome, { recursive: true });
    const envFile = path.join(managerHome, '.env');
    fs.writeFileSync(envFile, ['alpha', 'beta', 'gamma'].map(name => `SSH_SERVER_${name.toUpperCase()}_HOST=${name}.example\n`).join(''));
    const baseEnv = { ...process.env, HOME: home, SSH_MANAGER_HOME: managerHome, SSH_MANAGER_ENV: envFile, TERM: 'xterm-256color' };
    delete baseEnv.NO_COLOR;

    // --help: in sections, every command it ever listed, and `app`.
    const help = spawnSync(process.execPath, ['cli/ssh-manager.js', '--help'], { encoding: 'utf8', env: baseEnv });
    assert.equal(help.status, 0, help.stderr);
    const helpText = plain(help.stdout);
    for (const section of ['SERVERS', 'FILES', 'AGENTS AND THE INTERFACE', 'SETTINGS', 'EXAMPLES']) {
      assert.match(helpText, new RegExp(`^  ${section}$`, 'm'), `--help has a ${section} section`);
    }
    assert.match(helpText, /^ {4}app {2,}The desktop app/m, '--help lists `app`');
    assert.match(helpText, /^ {4}app --status {2,}/m);
    for (const command of ['server add', 'server list', 'server test', 'server show', 'server edit', 'server remove',
      'ssh <name>', 'exec <name>', 'exec group', 'monitor', 'session', 'sync push', 'sync pull', 'tunnel create',
      'tunnel list', 'tunnel close', 'control', 'config edit|show|init', 'tools list|configure', 'tools enable|disable',
      'tools reset', 'tools export', 'vault import', 'vault list', 'vault status', 'vault add|remove',
      'vault backup|restore', 'import <file>', 'import --from', 'import --template', 'export <file>']) {
      assert.ok(helpText.includes(`    ${command}`), `--help still lists ${command}`);
    }
    // The configuration paths are the user's own, and as long as they are.
    const fixedPart = helpText.slice(0, helpText.indexOf('  CONFIGURATION'));
    assert.ok(Math.max(...fixedPart.split('\n').map(line => line.length)) <= 80, '--help fits 80 columns');
    assert.match(help.stdout, /\x1b\[38;5;166m/, 'section titles in the app\'s orange');
    console.log('--help: sections, aligned, every command still listed, `app` added.');

    // NO_COLOR: no colour anywhere, the orange falls back to bold.
    const noColor = spawnSync(process.execPath, ['cli/ssh-manager.js', '--help'], { encoding: 'utf8', env: { ...baseEnv, NO_COLOR: '1' } });
    assert.doesNotMatch(noColor.stdout, /\x1b\[(?:0;)?3\d|\x1b\[38;5/, 'NO_COLOR: no colour in --help');
    assert.match(noColor.stdout, /\x1b\[1m/, 'bold stays: it is not a colour');
    const listing = spawnSync(process.execPath, ['cli/ssh-manager.js', 'server', 'list'], { encoding: 'utf8', env: { ...baseEnv, NO_COLOR: '1' } });
    assert.doesNotMatch(listing.stdout + listing.stderr, /\x1b\[(?:0;|1;)?3\d|\x1b\[38;5/, 'NO_COLOR: no colour in a direct command');
    const status = spawnSync(process.execPath, ['cli/ssh-manager.js', 'app', '--status'], { encoding: 'utf8', env: { ...baseEnv, NO_COLOR: '1' } });
    assert.ok([0, 1, 2].includes(status.status ?? -1), status.stderr);
    assert.match(status.stdout, /^desktop app (?:\S+ )?(?:installed|not installed|not available for .+)\n$/);
    assert.equal(status.stderr, '');
    console.log('NO_COLOR is honoured by --help, direct commands and `app --status`; the status is one line.');

    // The home screen, drawn from the libraries with a fake home.
    const draw = (columns, extra = {}) => {
      const script = ['source cli/lib/colors.sh', 'source cli/lib/config.sh', 'source cli/lib/menu.sh', `VERSION='${version}'`, 'show_main_menu'].join('; ');
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...baseEnv, COLUMNS: String(columns), SSH_MANAGER_KEEP_SCREEN: '1', MENU_DESKTOP_STATUS: 'desktop app 4.0.0 installed', ...extra },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const wide = draw(100);
    const wideText = plain(wide);
    // Every metacharacter, not only the dots: a version is data, not a pattern.
    const literal = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(wideText, new RegExp(`^  ▲ SSH Manager ${literal}$`, 'm'));
    assert.match(wideText, /^ {2}3 servers · ~\/\.ssh-manager\/\.env · desktop app 4\.0\.0 installed$/m, 'status line: count, file, app');
    assert.match(wideText, /^ {2}SERVERS {26}FILES$/m, 'two columns at 100 columns');
    assert.match(wideText, /^ {2}1 {2}List, test, add, edit {9}3 {2}Sync \(rsync\)$/m);
    assert.match(wideText, /^ {2}SETTINGS {25}a {2}Desktop app \(open \/ install\)$/m);
    assert.match(wideText, /^ {2}i {2}Import servers {16}\? {2}Help {8}q {2}Quit$/m);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '9', 'a', 't', 'v', 'i']) {
      assert.match(wideText, new RegExp(`(?:^| {2})${key} {2}[A-Z]`, 'm'), `the home screen offers ${key}`);
    }
    assert.match(wide, /\x1b\[38;5;166m/, 'keys and headings in the app\'s orange');
    assert.doesNotMatch(wideText, /[\u{1F300}-\u{1FAFF}☀-➿]/u, 'no emoji on the home screen');

    const narrowText = plain(draw(60));
    assert.match(narrowText, /^ {2}SERVERS$/m, 'one column under 72 columns');
    assert.doesNotMatch(narrowText, /SERVERS +FILES/);
    const order = ['SERVERS', 'FILES', 'AGENTS', 'SETTINGS'].map(title => narrowText.indexOf(`  ${title}\n`));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'servers, files, agents, then settings');
    assert.ok(Math.max(...narrowText.split('\n').map(line => line.length)) <= 60, 'nothing wider than the terminal');

    const bare = plain(draw(100, { MENU_DESKTOP_STATUS: '', SSH_MANAGER_ENV: path.join(home, 'missing.env'), NO_COLOR: '1' }));
    assert.match(bare, /^ {2}no servers yet$/m, 'each part of the status line degrades to nothing rather than breaking');
    console.log('Home screen: status line, every key, two columns at 72+ and one below, orange or bold.');

    // The real menu: every old way out still works, and the new keys do not break it.
    for (const input of ['q\n', '0\n', 'x\nt\n0\nv\n0\ni\n0\nq\n']) {
      const menu = spawnSync('bash', ['cli/ssh-manager'], { encoding: 'utf8', input, env: { ...baseEnv, COLUMNS: '100' } });
      assert.equal(menu.status, 0, `${JSON.stringify(input)}: ${menu.stderr}`);
      assert.match(plain(menu.stdout), /Goodbye!/);
      assert.match(plain(menu.stdout), /3 servers · ~\/\.ssh-manager\/\.env/);
    }
    console.log('Interactive menu: q and 0 quit, t / v / i open and close their sub-menus.');
  }
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
