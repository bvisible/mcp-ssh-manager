// Behavioural test for issue #55: groups derived from the per-server `group`
// field of the SSH configuration.
//
// Two group mechanisms coexist and must keep working together:
//   - explicit groups stored in .server-groups.json (ssh_group_manage)
//   - groups implied by `group = "..."` on a server entry (.env / TOML)
// Membership is the union of both, so tagging a server never rewrites the
// stored file and the stored file keeps working on its own.
//
// Every instance here gets its own groups file in a temp dir — the tests must
// never touch the real .server-groups.json at the repo root.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServerGroups } from '../src/server-groups.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-groups-'));
let fileCounter = 0;

// A ServerGroups bound to a throwaway groups file, optionally pre-seeded with
// explicit groups and fed a fixed server configuration.
function makeGroups(serverConfigs, storedGroups) {
  const groupsFile = path.join(tmpDir, `groups-${fileCounter++}.json`);
  if (storedGroups) fs.writeFileSync(groupsFile, JSON.stringify(storedGroups, null, 2));

  return {
    groupsFile,
    groups: new ServerGroups({
      groupsFile,
      serverConfigProvider: serverConfigs === undefined ? undefined : () => serverConfigs
    })
  };
}

const configs = {
  web1: { name: 'web1', host: '10.0.0.1', group: 'production' },
  web2: { name: 'web2', host: '10.0.0.2', group: 'production' },
  db1: { name: 'db1', host: '10.0.0.3', group: 'edge' },
  scratch: { name: 'scratch', host: '10.0.0.4' },
  blank: { name: 'blank', host: '10.0.0.5', group: '   ' }
};

// A group name absent from .server-groups.json still resolves when servers
// carry it — this is the whole point of the field.
function testGroupFromConfigOnly() {
  const { groups } = makeGroups(configs);
  const group = groups.getGroup('edge');

  assert.deepStrictEqual(group.servers, ['db1']);
  assert.strictEqual(group.dynamic, true, 'a config-only group is dynamic');
  assert.strictEqual(group.fromConfig, true, 'a config-only group is flagged as coming from the config');
  ok('a group that exists only in the server config resolves to its tagged servers');
}

// The shipped defaults include an empty "production" group; tagging servers
// must fill it in rather than being ignored.
function testDefaultGroupGetsConfigMembers() {
  const { groups } = makeGroups(configs);
  const group = groups.getGroup('production');

  assert.deepStrictEqual(group.servers, ['web1', 'web2']);
  ok('the empty default "production" group picks up servers tagged production');
}

// Explicit membership and config membership add up; group settings survive.
function testUnionWithExplicitGroup() {
  const { groups } = makeGroups(configs, {
    production: { description: 'Prod', servers: ['legacy1'], strategy: 'sequential', delay: 1500 }
  });
  const group = groups.getGroup('production');

  assert.deepStrictEqual(group.servers, ['legacy1', 'web1', 'web2'], 'stored members first, then config ones');
  assert.strictEqual(group.strategy, 'sequential', 'stored strategy is preserved');
  assert.strictEqual(group.delay, 1500, 'stored delay is preserved');
  ok('stored members and config-tagged members are merged, group settings preserved');
}

function testNoDuplicateMembers() {
  const { groups } = makeGroups(configs, { edge: { description: 'Edge', servers: ['DB1'] } });
  assert.deepStrictEqual(groups.getGroup('edge').servers, ['db1'], 'same server listed twice appears once');
  ok('a server both stored and tagged is listed once (case-insensitive)');
}

function testGroupNameCaseInsensitive() {
  const { groups } = makeGroups({
    a: { name: 'a', host: '10.0.0.1', group: 'Staging' },
    b: { name: 'b', host: '10.0.0.2', group: 'STAGING' }
  });

  assert.deepStrictEqual(groups.getGroup('staging').servers, ['a', 'b']);
  assert.deepStrictEqual(groups.getGroup('Staging').servers, ['a', 'b']);
  ok('group names are case-insensitive on both the config and the lookup side');
}

function testUntaggedServersIgnored() {
  const { groups } = makeGroups(configs);
  const names = groups.listGroups().flatMap(g => (g.name === 'all' ? [] : g.servers));

  assert.ok(!names.includes('scratch'), 'a server without group joins no group');
  assert.ok(!names.includes('blank'), 'a whitespace-only group is not a group');
  assert.throws(() => groups.getGroup('   '), /not found/, 'a blank group name resolves to nothing');
  ok('servers with no group (or a blank one) join no group');
}

function testUnknownGroupStillThrows() {
  const { groups } = makeGroups(configs);
  assert.throws(() => groups.getGroup('nope'), /Group 'nope' not found/);
  ok('an unknown group name still throws "not found"');
}

// Regression: getAllServers() used to scan process.env, so the built-in "all"
// group silently skipped every TOML-defined server.
function testAllGroupSeesConfiguredServers() {
  const { groups } = makeGroups({
    tomlonly: { name: 'tomlonly', host: '10.0.0.9' }
  });

  assert.deepStrictEqual(groups.getGroup('all').servers, ['tomlonly'], 'all must include non-env servers');
  ok('the "all" group covers servers that exist only in the TOML config');
}

// Without an injected provider (standalone use) the environment scan stays.
function testEnvFallbackWithoutProvider() {
  const key = 'SSH_SERVER_GROUPFALLBACK_HOST';
  process.env[key] = '10.0.0.10';

  try {
    const { groups } = makeGroups(undefined);
    assert.ok(groups.getGroup('all').servers.includes('groupfallback'), 'env servers still found');
  } finally {
    delete process.env[key];
  }

  ok('with no config provider, the "all" group falls back to scanning the environment');
}

function testListGroupsIncludesConfigGroups() {
  const { groups } = makeGroups(configs);
  const listed = groups.listGroups();
  const byName = Object.fromEntries(listed.map(g => [g.name, g]));

  assert.ok(byName.edge, 'config-only group is listed');
  assert.strictEqual(byName.edge.serverCount, 1);
  assert.strictEqual(byName.edge.fromConfig, true);
  assert.strictEqual(byName.production.serverCount, 2, 'default group reports its config members');
  assert.strictEqual(byName.production.fromConfig, true);
  assert.strictEqual(byName.staging.serverCount, 0, 'untagged default groups stay empty');
  assert.strictEqual(byName.staging.fromConfig, undefined);
  assert.strictEqual(listed.filter(g => g.name === 'edge').length, 1, 'no duplicate entry');
  ok('listGroups reports config-derived groups once, flagged, with correct counts');
}

// Editing a config-derived group through ssh_group_manage cannot work — the
// error has to say where to change it instead of a bare "not found".
function testConfigGroupIsReadOnly() {
  const { groups } = makeGroups(configs);

  for (const [label, run] of [
    ['add-servers', () => groups.addServers('edge', ['web1'])],
    ['remove-servers', () => groups.removeServers('edge', ['db1'])],
    ['update', () => groups.updateGroup('edge', { description: 'x' })],
    ['delete', () => groups.deleteGroup('edge')]
  ]) {
    assert.throws(run, /SSH server configuration/, `${label} must explain the group comes from the config`);
  }

  ok('a config-derived group cannot be edited via group management, with a helpful error');
}

// The stored file must never absorb config-derived members, or they would go
// stale the moment a server is retagged.
function testConfigMembersAreNotPersisted() {
  const { groups, groupsFile } = makeGroups(configs, {
    production: { description: 'Prod', servers: ['legacy1'], strategy: 'parallel' }
  });

  groups.addServers('production', ['legacy2']);
  const saved = JSON.parse(fs.readFileSync(groupsFile, 'utf8'));

  assert.deepStrictEqual(saved.production.servers, ['legacy1', 'legacy2'], 'only explicit members are stored');
  assert.deepStrictEqual(
    groups.getGroup('production').servers,
    ['legacy1', 'legacy2', 'web1', 'web2'],
    'config members still resolve at read time'
  );
  ok('config-derived members are resolved at read time, never written to .server-groups.json');
}

// Regression: dynamic groups are never written to .server-groups.json, so any
// instance started after the first group edit used to load a file without them
// — and 'all' was gone for good ("Group 'all' not found").
function testDynamicGroupSurvivesSavedFile() {
  const { groups, groupsFile } = makeGroups(configs);

  groups.createGroup('team', ['web1']);
  const saved = JSON.parse(fs.readFileSync(groupsFile, 'utf8'));
  assert.ok(!saved.all, 'the dynamic group is still not persisted');

  const restarted = new ServerGroups({ groupsFile, serverConfigProvider: () => configs });
  assert.deepStrictEqual(
    restarted.getGroup('all').servers.sort(),
    ['blank', 'db1', 'scratch', 'web1', 'web2'],
    'all must still resolve after a group edit was saved'
  );
  assert.deepStrictEqual(restarted.getGroup('team').servers, ['web1'], 'stored group is reloaded');
  ok('the "all" group survives a saved .server-groups.json (regression)');
}

// End to end: the executor really runs on the servers a group was derived from.
async function testExecuteOnConfigGroup() {
  const { groups } = makeGroups(configs);
  const visited = [];

  // Forced parallel: the shipped "production" default is rolling with a 5s
  // delay between servers, which would make this test sleep for no reason.
  const result = await groups.executeOnGroup('production', async (server) => {
    visited.push(server);
    return { code: 0 };
  }, { strategy: 'parallel' });

  assert.deepStrictEqual(visited.sort(), ['web1', 'web2'], 'command ran on both tagged servers');
  assert.strictEqual(result.summary.successful, 2);
  assert.strictEqual(result.summary.failed, 0);
  ok('ssh_execute_group runs on a group that only exists through the server config');
}

async function main() {
  testGroupFromConfigOnly();
  testDefaultGroupGetsConfigMembers();
  testUnionWithExplicitGroup();
  testNoDuplicateMembers();
  testGroupNameCaseInsensitive();
  testUntaggedServersIgnored();
  testUnknownGroupStillThrows();
  testAllGroupSeesConfiguredServers();
  testEnvFallbackWithoutProvider();
  testListGroupsIncludesConfigGroups();
  testConfigGroupIsReadOnly();
  testConfigMembersAreNotPersisted();
  testDynamicGroupSurvivesSavedFile();
  await testExecuteOnConfigGroup();

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n✅ server group tests passed (${passed} checks)`);
}

main();
