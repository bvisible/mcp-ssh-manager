import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-group-storage-'));
process.env.SSH_MANAGER_HOME = path.join(scratch, 'home');
process.env.SSH_LOG_FILE = path.join(scratch, 'log');
process.env.SSH_HISTORY_FILE = path.join(scratch, 'history');
delete process.env.SSH_GROUPS_FILE;
const { ServerGroups, defaultGroupsPath, listGroups, createGroup } = await import('../src/server-groups.js');

try {
  const groupsFile = defaultGroupsPath();
  assert.equal(groupsFile, path.join(scratch, 'home', 'groups.json'));
  const legacyGroupsFile = path.join(scratch, 'application', '.server-groups.json');
  fs.mkdirSync(path.dirname(legacyGroupsFile));
  const legacy = JSON.stringify({ old: { servers: ['prod'], description: 'Original', strategy: 'sequential' } });
  fs.writeFileSync(legacyGroupsFile, legacy);
  const groups = new ServerGroups({ groupsFile, legacyGroupsFile });
  assert.deepEqual(groups.getGroup('old').servers, ['prod']);
  assert.equal(fs.existsSync(path.dirname(groupsFile)), false, 'reading legacy data creates nothing');
  groups.createGroup('new', ['staging']);
  assert.equal(fs.readFileSync(legacyGroupsFile, 'utf8'), legacy, 'migration preserves the old package for rollback');
  assert.deepEqual(new ServerGroups({ groupsFile }).getGroup('old').servers, ['prod']);
  assert.deepEqual(new ServerGroups({ groupsFile }).getGroup('new').servers, ['staging']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(groupsFile).mode & 0o777, 0o600);

  // Another installed copy sees updates, and stale legacy data cannot replace
  // the shared data on a subsequent launch or resurrect a deleted group.
  const other = new ServerGroups({ groupsFile, legacyGroupsFile });
  other.deleteGroup('old');
  assert.throws(() => new ServerGroups({ groupsFile, legacyGroupsFile }).getGroup('old'), /not found/);
  assert.ok(listGroups().some(group => group.name === 'new'));
  createGroup('shared', ['one']);
  other.groups = other.loadGroups();
  assert.deepEqual(other.getGroup('shared').servers, ['one']);

  // A deterministic unwritable destination on every OS, without relying on
  // chmod (which root and Windows may ignore): parent is a regular file.
  const blocked = path.join(scratch, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const failed = new ServerGroups({ groupsFile: path.join(blocked, 'groups.json'), legacyGroupsFile });
  assert.throws(() => failed.createGroup('unsaved', ['x']), /Could not save server groups/);
  assert.throws(() => failed.getGroup('unsaved'), /not found/);
  assert.throws(() => failed.updateGroup('old', { description: 'unsaved' }), /Could not save server groups/);
  assert.equal(failed.getGroup('old').description, 'Original');
  assert.throws(() => failed.deleteGroup('old'), /Could not save server groups/);
  assert.deepEqual(failed.getGroup('old').servers, ['prod']);
  assert.equal(fs.readFileSync(legacyGroupsFile, 'utf8'), legacy);

  fs.writeFileSync(groupsFile, '{broken');
  const corrupt = new ServerGroups({ groupsFile, legacyGroupsFile });
  assert.throws(() => corrupt.createGroup('replacement', []), /Could not save server groups/);
  assert.equal(fs.readFileSync(groupsFile, 'utf8'), '{broken', 'corruption is never silently overwritten');
  console.log('Groups persistence: migration, shared storage, rollback, permissions and write failures passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
