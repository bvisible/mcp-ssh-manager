// The CLI's .env writers: remove and update touch one server's lines and only those,
// update keeps what it does not rewrite, and a value is written so that the engine's
// dotenv reads it back as it was.
//
// Three defects, found by reading jaredshuai's fork and reproduced here first:
//  - `server remove prod` deleted `prod_eu` too: it matched the bare prefix
//    ^SSH_SERVER_PROD_, which every longer name starts with;
//  - editing a server rewrote it from seven fields, so a read-only server became
//    unrestricted (mode, allow patterns, audit log, group, proxy jump were dropped);
//  - a password such as `a#b c"d` was written bare and read back as `a`: dotenv
//    starts a comment at any "#".
// The functions of cli/lib/config.sh are run by a real bash on a scratch file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

if (process.platform === 'win32') {
  console.log('Skipped: the CLI library is Bash.');
  process.exit(0);
}

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-cli-env-'));
let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

/** Run a bash snippet with the CLI library loaded, on a given .env file. */
function cli(envFile, snippet, ...args) {
  return spawnSync('bash', ['-c', `cd "${repo}/cli" && . lib/colors.sh && . lib/config.sh && ${snippet}`, 'bash', ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: scratch, SSH_MANAGER_ENV: envFile, SSH_MANAGER_HOME: path.join(scratch, 'home') },
  });
}
const read = file => dotenv.parse(fs.readFileSync(file));
/** The mode and the text of a file from one open: it is looked at, not looked up twice. */
function look(file) {
  const fd = fs.openSync(file, 'r');
  try { return { mode: fs.fstatSync(fd).mode & 0o777, text: fs.readFileSync(fd, 'utf8') }; } finally { fs.closeSync(fd); }
}
const servers = file => Object.keys(read(file)).filter(key => key.endsWith('_HOST')).map(key => key.slice(11, -5)).sort();

const seed = `# Server: prod
SSH_SERVER_PROD_HOST=10.0.0.1
SSH_SERVER_PROD_USER=deploy
SSH_SERVER_PROD_PORT=22
SSH_SERVER_PROD_PASSWORD=old
SSH_SERVER_PROD_MODE=readonly
SSH_SERVER_PROD_ALLOW_PATTERNS="^ls "
SSH_SERVER_PROD_AUDIT_LOG=/var/log/prod-audit.jsonl
SSH_SERVER_PROD_GROUP=web
SSH_SERVER_PROD_PROXYJUMP=bastion

# Server: prod_eu
SSH_SERVER_PROD_EU_HOST=10.0.0.2
SSH_SERVER_PROD_EU_USER=deploy
SSH_SERVER_PROD_EU_PASSWORD=keepme
SSH_SERVER_PROD_EU_MODE=restricted

# Server: prod_eu_2
SSH_SERVER_PROD_EU_2_HOST=10.0.0.3
SSH_SERVER_PROD_EU_2_USER=deploy
SSH_SERVER_PROD_EU_2_KEYPATH=/keys/eu2
`;
const fresh = name => { const file = path.join(scratch, `${name}.env`); fs.writeFileSync(file, seed, { mode: 0o640 }); return file; };

try {
  // ── remove ────────────────────────────────────────────────────────────────
  {
    const file = fresh('remove');
    const before = read(file);
    const done = cli(file, 'remove_server_from_env prod');
    assert.equal(done.status, 0, done.stderr);
    const after = read(file);
    assert.deepEqual(servers(file), ['PROD_EU', 'PROD_EU_2'], 'only prod is gone');
    for (const key of Object.keys(before).filter(key => key.startsWith('SSH_SERVER_PROD_EU'))) assert.equal(after[key], before[key], `${key} survived intact`);
    assert.ok(!Object.keys(after).some(key => key.startsWith('SSH_SERVER_PROD_') && !key.startsWith('SSH_SERVER_PROD_EU')), 'every setting of prod is gone, mode and audit log included');
    assert.equal(look(file).mode, 0o640, 'the file keeps its mode');
    cli(file, 'remove_server_from_env prod_eu');
    assert.deepEqual(servers(file), ['PROD_EU_2'], 'removing prod_eu leaves prod_eu_2');
    assert.notEqual(cli(file, 'remove_server_from_env prod_eu').status, 0, 'a server that is not there is reported');
    ok('removing a server removes its lines and no longer those of a server whose name starts with it');
  }

  // ── update ────────────────────────────────────────────────────────────────
  {
    const file = fresh('update');
    const before = read(file);
    const done = cli(file, 'update_server_in_env prod new.example.com root key /keys/prod 2222 "Primary" /srv/app');
    assert.equal(done.status, 0, done.stderr);
    const after = read(file);
    assert.equal(after.SSH_SERVER_PROD_HOST, 'new.example.com');
    assert.equal(after.SSH_SERVER_PROD_USER, 'root');
    assert.equal(after.SSH_SERVER_PROD_PORT, '2222');
    assert.equal(after.SSH_SERVER_PROD_KEYPATH, '/keys/prod');
    assert.equal(after.SSH_SERVER_PROD_DESCRIPTION, 'Primary');
    assert.equal(after.SSH_SERVER_PROD_DEFAULT_DIR, '/srv/app');
    assert.ok(!('SSH_SERVER_PROD_PASSWORD' in after), 'switching to a key drops the old password');
    for (const key of ['MODE', 'ALLOW_PATTERNS', 'AUDIT_LOG', 'GROUP', 'PROXYJUMP']) {
      assert.equal(after[`SSH_SERVER_PROD_${key}`], before[`SSH_SERVER_PROD_${key}`], `${key} is not lost by an edit`);
    }
    for (const key of Object.keys(before).filter(key => key.startsWith('SSH_SERVER_PROD_EU'))) assert.equal(after[key], before[key], `${key} of another server is untouched`);
    const { mode, text } = look(file);
    assert.equal(mode, 0o640, 'the file keeps its mode');
    assert.equal(text.match(/^# Server: prod$/gm).length, 1, 'the server keeps its one comment');
    assert.ok(text.indexOf('SSH_SERVER_PROD_HOST') < text.indexOf('# Server: prod_eu\n'), 'and its place in the file');

    cli(file, 'update_server_in_env prod new.example.com root password "p w" 22 "" ""');
    const again = read(file);
    assert.equal(again.SSH_SERVER_PROD_PASSWORD, 'p w');
    assert.ok(!('SSH_SERVER_PROD_KEYPATH' in again) && !('SSH_SERVER_PROD_DESCRIPTION' in again) && !('SSH_SERVER_PROD_DEFAULT_DIR' in again), 'an emptied description and directory are cleared, as before');
    assert.equal(again.SSH_SERVER_PROD_MODE, 'readonly', 'still read-only after a second edit');
    ok('editing a server rewrites what the wizard asks and keeps its mode, patterns, audit log, group, proxy jump and place');
  }

  // ── writing values ────────────────────────────────────────────────────────
  {
    const file = path.join(scratch, 'values.env');
    const values = ['plain', 'p w', 'a#b', 'a#b c"d', "it's", `it's "both"`, ' lead', 'trail ', "'quoted'", '"dq"', '`tick`', 'a$b\\n', 'x=y', '/path with space/key', '#start', 'ünï©ode', '$(touch /tmp/never)', `a'b"c\`d`, ''];
    for (const [index, value] of values.entries()) {
      fs.writeFileSync(file, '');
      const name = `v${index}`;
      const done = cli(file, 'add_server_to_env "$1" 10.0.0.9 root password "$2" 22 "$2"', name, value);
      assert.equal(done.status, 0, `${JSON.stringify(value)}: ${done.stderr}`);
      const parsed = read(file);
      assert.equal(parsed[`SSH_SERVER_${name.toUpperCase()}_PASSWORD`], value, `password ${JSON.stringify(value)} is read back as written`);
      assert.equal(parsed[`SSH_SERVER_${name.toUpperCase()}_HOST`], '10.0.0.9');
      const viaCli = cli(file, 'get_server_config "$1" PASSWORD', name);
      if (value) assert.equal(viaCli.stdout, value, `the CLI reads ${JSON.stringify(value)} back as the engine does`);
    }
    // Ordinary values are written exactly as before.
    fs.writeFileSync(file, '');
    cli(file, 'add_server_to_env web 10.0.0.9 root password "p@ss w0rd!" 22 "My server" unrestricted "" ""');
    assert.equal(fs.readFileSync(file, 'utf8'), '\n# Server: web\nSSH_SERVER_WEB_HOST=10.0.0.9\nSSH_SERVER_WEB_USER=root\nSSH_SERVER_WEB_PORT=22\nSSH_SERVER_WEB_PASSWORD=p@ss w0rd!\nSSH_SERVER_WEB_DESCRIPTION="My server"\n', 'a plain value is written byte for byte as it always was');
    ok(`${values.length} awkward values are written so that dotenv and the CLI read them back as they were; ordinary ones are written as before`);

    fs.writeFileSync(file, '');
    // Quotes in the middle of a bare value are fine (they are in the list above). A value that
    // has to be quoted AND holds all three characters cannot be written: refused, not mangled.
    const refused = cli(file, 'add_server_to_env bad 10.0.0.9 root password "$1" 22', `#a'b"c\`d`);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(refused.stderr, /three quote characters/);
    assert.equal(fs.readFileSync(file, 'utf8'), '', 'a value the format cannot carry writes nothing');
    const multiline = cli(file, 'add_server_to_env bad 10.0.0.9 root password "$1" 22', 'a\nb');
    assert.notEqual(multiline.status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    ok('a value the .env format cannot carry is refused with a reason, and nothing is written');
  }

  // ── the field list is the engine's ────────────────────────────────────────
  {
    const loader = fs.readFileSync(path.join(repo, 'src', 'config-loader.js'), 'utf8');
    // HOST is the line the loader finds the server by, so it is not read through env[...] like the rest.
    const read_ = new Set([...loader.matchAll(/env\[`SSH_SERVER_\$\{match\[1\]\}_([A-Z_]+)`\]/g)].map(match => match[1]).concat('HOST'));
    const config = fs.readFileSync(path.join(repo, 'cli', 'lib', 'config.sh'), 'utf8');
    const listed = new Set(/SERVER_ENV_FIELDS="([^"]+)"/.exec(config)[1].split(' '));
    assert.ok(read_.size >= 20, `found only ${read_.size} fields in the loader`);
    for (const field of read_) assert.ok(listed.has(field), `the engine reads ${field}, so removing a server would leave it behind`);
    const extra = [...listed].filter(field => !read_.has(field));
    assert.deepEqual(extra, ['APPROVAL'], 'only APPROVAL (an old setting the loader rejects) is listed beyond what the loader reads');
    ok(`SERVER_ENV_FIELDS has the ${read_.size} settings the engine reads, plus the old APPROVAL`);
  }

  console.log(`\n✅ CLI .env tests passed (${passed} checks)`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
