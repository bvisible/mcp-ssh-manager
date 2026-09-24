// Tests for saved commands.
//
// These are shortcuts a person picks from a list next to a terminal, as opposed
// to the aliases an agent expands. What matters is the scoping and the
// confirmation flag: a `systemctl reload nginx` offered on a database server is
// a mistake waiting for a tired evening, and a command that deletes things has
// to say so where the person clicking can see it.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listSavedCommands, saveCommand, deleteCommand, commandsForServer,
  suggestedCommands, savedCommandsPath,
} from '../src/saved-commands.js';
import { ControlPlane } from '../src/control-plane.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'));
process.env.SSH_MANAGER_KEY_SOURCE = 'file';
process.env.SSH_MANAGER_HOME = scratch;

function testAnEmptyListIsEmptyNotAnError() {
  assert.deepStrictEqual(listSavedCommands(), [],
    'no file means nobody has saved a command yet, which is not a failure');
  assert.ok(!fs.existsSync(savedCommandsPath()),
    'and reading must not create the file — nothing appears in a home directory unasked');
  ok('an empty list reads as empty, and reading writes nothing');
}

function testSuggestionsAreOfferedNotInstalled() {
  const suggestions = suggestedCommands();
  assert.ok(suggestions.length >= 5, 'there should be enough to be useful');
  assert.ok(suggestions.every(s => s.name && s.command), 'each needs a name and a command');
  // The one that changes something on a server is the one that must ask.
  const reload = suggestions.find(s => s.command.includes('systemctl reload'));
  assert.strictEqual(reload.confirmBeforeRun, true,
    'a suggestion that acts on a service must be marked to confirm');
  assert.ok(suggestions.filter(s => s.command.startsWith('df') || s.command.startsWith('free'))
    .every(s => s.confirmBeforeRun === false),
    'and one that only looks must not, or the confirmation becomes noise');
  assert.deepStrictEqual(listSavedCommands(), [], 'suggestions are offered, never written');
  ok('suggestions are offered without being installed, and only the acting ones confirm');
}

function testSavingAndEditing() {
  const saved = saveCommand({
    name: 'Reload nginx',
    command: 'systemctl reload nginx',
    description: 'Without dropping connections',
    serverNames: ['web1'],
    confirmBeforeRun: true,
  });
  assert.ok(saved.id, 'an id is assigned');
  assert.strictEqual(listSavedCommands().length, 1);

  // Editing keeps the id, or every save would append a duplicate.
  const edited = saveCommand({ ...saved, name: 'Reload nginx (web tier)' });
  assert.strictEqual(edited.id, saved.id);
  assert.strictEqual(listSavedCommands().length, 1, 'editing must replace, not append');
  assert.strictEqual(listSavedCommands()[0].name, 'Reload nginx (web tier)');
  ok('a command saves, and editing replaces it rather than duplicating it');
}

function testTheFileIsPrivate() {
  const mode = fs.statSync(savedCommandsPath()).mode & 0o777;
  assert.strictEqual(mode, 0o600,
    `commands can contain paths and hostnames, so the file is the owner's alone — got ${mode.toString(8)}`);
  ok('the file is readable only by its owner');
}

function testEmptyValuesAreRefused() {
  // This list is edited through an HTTP route; a row with no command is a row
  // that does nothing and cannot be told apart from one that does.
  assert.throws(() => saveCommand({ name: '', command: 'ls' }), /name is required/);
  assert.throws(() => saveCommand({ name: 'Something', command: '   ' }), /command is required/);
  assert.strictEqual(listSavedCommands().length, 1, 'and nothing is written when refused');
  ok('a command with no name or no command is refused');
}

function testScoping() {
  saveCommand({ name: 'Disk usage', command: 'df -h', serverNames: [], confirmBeforeRun: false });
  saveCommand({ name: 'Dump db', command: 'mysqldump app', serverNames: ['db1'], confirmBeforeRun: true });

  const onWeb = commandsForServer('web1').map(c => c.name).sort();
  assert.deepStrictEqual(onWeb, ['Disk usage', 'Reload nginx (web tier)'],
    'a server sees the global commands plus those naming it');
  const onDb = commandsForServer('db1').map(c => c.name).sort();
  assert.deepStrictEqual(onDb, ['Disk usage', 'Dump db']);
  assert.ok(!onDb.includes('Reload nginx (web tier)'),
    'and never one scoped to another server — that is the whole point of scoping');
  ok('a server is offered the global commands plus its own, and nothing else');
}

function testDeleting() {
  const target = listSavedCommands().find(c => c.name === 'Disk usage');
  assert.strictEqual(deleteCommand(target.id), true);
  assert.strictEqual(deleteCommand(target.id), false, 'deleting twice reports honestly');
  assert.strictEqual(deleteCommand('never-existed'), false);
  assert.ok(!listSavedCommands().some(c => c.id === target.id));
  ok('deleting works and says so honestly when there was nothing to delete');
}

function testACorruptFileDoesNotBreakTheScreen() {
  fs.writeFileSync(savedCommandsPath(), '{ not json at all');
  assert.deepStrictEqual(listSavedCommands(), [],
    'a corrupt file degrades to an empty list — an unreadable screen would be worse');
  ok('a corrupt file degrades to an empty list instead of breaking the interface');
}

async function testTheRoutes() {
  fs.rmSync(savedCommandsPath(), { force: true });
  const plane = new ControlPlane({
    socketPath: path.join(scratch, 'c.sock'),
    port: 0,
    vaultPath: path.join(scratch, 'vault.json'),
  });
  const { url } = await plane.start();
  const base = url.split('/?')[0];
  const q = `token=${plane.token}`;

  try {
    const empty = await fetch(`${base}/api/commands?${q}`).then(r => r.json());
    assert.deepStrictEqual(empty.commands, []);
    assert.ok(empty.suggestions.length > 0, 'an empty list comes with suggestions to start from');

    const created = await fetch(`${base}/api/commands?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Load', command: 'uptime', serverNames: [], confirmBeforeRun: false }),
    }).then(r => r.json());
    assert.ok(created.command.id);

    const after = await fetch(`${base}/api/commands?${q}`).then(r => r.json());
    assert.strictEqual(after.commands.length, 1);
    assert.deepStrictEqual(after.suggestions, [],
      'once something is saved, the suggestions stop being offered');

    const refused = await fetch(`${base}/api/commands?${q}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No command' }),
    });
    assert.strictEqual(refused.status, 400);

    assert.strictEqual((await fetch(`${base}/api/commands`)).status, 401,
      'the list names hosts and paths, so it needs the token like everything else');

    const gone = await fetch(`${base}/api/commands?${q}&id=${created.command.id}`, { method: 'DELETE' });
    assert.strictEqual(gone.status, 200);
    assert.strictEqual((await fetch(`${base}/api/commands?${q}&id=nope`, { method: 'DELETE' })).status, 404);
    ok('the routes list, save, refuse the incomplete, delete, and require the token');
  } finally {
    await plane.stop();
  }
}

async function main() {
  try {
    testAnEmptyListIsEmptyNotAnError();
    testSuggestionsAreOfferedNotInstalled();
    testSavingAndEditing();
    testTheFileIsPrivate();
    testEmptyValuesAreRefused();
    testScoping();
    testDeleting();
    testACorruptFileDoesNotBreakTheScreen();
    await testTheRoutes();
    console.log(`\n✅ saved command tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
