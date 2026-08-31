#!/usr/bin/env node
/**
 * Install the last published release, then upgrade to this working tree, and
 * prove nothing the user had has changed.
 *
 * ## Why this exists next to tests/test-upgrade.js
 *
 * That test writes a `.env` shaped like a 3.8.x one and drives the *current*
 * loader against it. It catches a renamed field or a changed precedence rule,
 * which is most of the risk — but it never runs the old code, so it cannot see
 * a difference between what 3.8.5 actually did and what we believe it did.
 *
 * This one installs `mcp-ssh-manager@<previous>` from the registry, asks it over
 * the real MCP protocol what servers it sees, installs the working tree over the
 * top, and asks again. The two answers must match field for field.
 *
 * It is deliberately not part of `npm test`: it hits the network and takes about
 * a minute. Run it before cutting a major.
 *
 * Usage: node scripts/test-upgrade-from-published.mjs [previous-version]
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PREVIOUS = process.argv[2] || '3.8.5';

let passed = 0;
const ok = label => console.log(`\x1b[32m✓\x1b[0m ${++passed}. ${label}`);

/** A .env with one of everything, as somebody upgrading actually has. */
const ENV_FILE = `
SSH_SERVER_PROD_HOST=prod.example.com
SSH_SERVER_PROD_USER=deploy
SSH_SERVER_PROD_PASSWORD=motdepasse-prod
SSH_SERVER_PROD_PORT=22
SSH_SERVER_PROD_DEFAULT_DIR=/var/www
SSH_SERVER_PROD_DESCRIPTION=Production
SSH_SERVER_PROD_GROUP=production
SSH_SERVER_PROD_SUDO_PASSWORD=sudo-secret

SSH_SERVER_DB_HOST=db.example.com
SSH_SERVER_DB_USER=root
SSH_SERVER_DB_KEYPATH=~/.ssh/id_ed25519
SSH_SERVER_DB_PASSPHRASE=phrase-de-la-cle
SSH_SERVER_DB_PORT=2222
SSH_SERVER_DB_MODE=readonly

SSH_SERVER_BASTION_HOST=bastion.example.com
SSH_SERVER_BASTION_USER=jumpuser
SSH_SERVER_BASTION_KEYPATH=~/.ssh/bastion_key

SSH_SERVER_INTERNAL_HOST=10.0.0.5
SSH_SERVER_INTERNAL_USER=admin
SSH_SERVER_INTERNAL_PROXYJUMP=bastion
SSH_SERVER_INTERNAL_PLATFORM=windows
`.trimStart();

/**
 * Ask an installed copy what it can see, over the real protocol.
 *
 * @param {string} cwd - Working directory, which is where the .env is found
 * @param {string} entry - Path to the installed src/index.js
 * @returns {Promise<object>} The parsed ssh_list_servers result
 */
function interrogate(cwd, entry) {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'upgrade-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'ssh_list_servers', arguments: {} } },
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      // A clean environment: the point is what the .env holds, and an
      // SSH_SERVER_* left in this shell would be read as a fourth server.
      env: { PATH: process.env.PATH, HOME: cwd, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', () => { /* the engine logs to stderr by design */ });
    child.on('error', reject);

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

    setTimeout(() => {
      child.kill();
      const reply = out.split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(message => message?.id === 2);
      if (!reply) return reject(new Error(`no answer from ${entry}\n${out.slice(0, 400)}`));
      const text = reply.result?.content?.[0]?.text ?? '';
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ raw: text });
      }
    }, 6000);
  });
}

/** Everything that must survive an upgrade, in a comparable shape. */
function fingerprint(listing) {
  const servers = listing.servers || listing;
  return Object.fromEntries((Array.isArray(servers) ? servers : Object.values(servers))
    .map(s => [s.name, {
      host: s.host, user: s.user, port: s.port,
      defaultDir: s.defaultDir ?? s.default_dir,
      description: s.description, group: s.group,
      platform: s.platform, mode: s.mode,
      proxyJump: s.proxyJump ?? s.proxy_jump,
      auth: s.auth ?? s.authType ?? undefined,
    }])
    .sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-real-'));
  console.log(`  workspace: ${work}\n`);
  try {
    fs.writeFileSync(path.join(work, '.env'), ENV_FILE);
    const envBefore = fs.readFileSync(path.join(work, '.env'), 'utf8');
    fs.writeFileSync(path.join(work, 'package.json'), '{"name":"upgrade-check","private":true}\n');

    // --- the version they are on today -----------------------------------
    execFileSync('npm', ['install', `mcp-ssh-manager@${PREVIOUS}`,
      '--no-audit', '--no-fund', '--silent'], { cwd: work, stdio: 'ignore' });
    const installed = path.join(work, 'node_modules', 'mcp-ssh-manager');
    const oldVersion = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    assert.strictEqual(oldVersion, PREVIOUS);
    ok(`mcp-ssh-manager@${PREVIOUS} installed from the registry`);

    const before = fingerprint(await interrogate(work, path.join(installed, 'src', 'index.js')));
    assert.ok(Object.keys(before).length >= 4,
      `${PREVIOUS} should see 4 servers, saw ${JSON.stringify(before)}`);
    ok(`${PREVIOUS} reads the .env and reports ${Object.keys(before).length} servers`);

    // --- the upgrade, exactly as npm would do it --------------------------
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', work],
      { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('npm', ['install', path.join(work, packed),
      '--no-audit', '--no-fund', '--silent'], { cwd: work, stdio: 'ignore' });
    const newVersion = JSON.parse(
      fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    ok(`upgraded in place to ${newVersion}`);

    const after = fingerprint(await interrogate(work, path.join(installed, 'src', 'index.js')));
    assert.deepStrictEqual(after, before,
      `the upgrade changed what the user sees:\n${JSON.stringify({ before, after }, null, 2)}`);
    ok('every server, field for field, is exactly what it was before');

    // --- and nothing was touched on the way -------------------------------
    assert.strictEqual(fs.readFileSync(path.join(work, '.env'), 'utf8'), envBefore);
    ok('the .env is byte-for-byte unchanged');

    for (const unexpected of ['vault.json', '.server-groups.json', 'commands.json',
      'commands.log.jsonl', '.ssh-manager']) {
      assert.ok(!fs.existsSync(path.join(work, unexpected)),
        `the upgrade created ${unexpected} without being asked`);
    }
    ok('no vault, no groups file, no command log — nothing appears uninvited');

    const home = path.join(work, '.ssh-manager');
    assert.ok(!fs.existsSync(home), 'no ~/.ssh-manager either');
    ok('the home directory is untouched: upgrading is not migrating');

    console.log(`\n\x1b[32m✅ upgrade ${PREVIOUS} → ${newVersion} is a no-op for the user (${passed} checks)\x1b[0m`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`\n\x1b[31m❌ ${error.message}\x1b[0m`);
  process.exit(1);
});
