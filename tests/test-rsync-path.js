// Regression tests for Windows local paths passed to MSYS2 rsync.
//
// rsync treats the colon in an unmodified path such as C:\work\file.txt as a
// remote-host separator. The MCP keeps that native path for Node filesystem
// checks, then converts only the spawned rsync argument to /c/work/file.txt.
//
// Four layers, because the unit conversion alone would not keep this stable:
//   1. table of known conversions
//   2. invariants that must hold for ANY Windows input, including ones nobody
//      thought to tabulate (no drive-colon, no backslash, idempotence)
//   3. platform isolation — nothing changes off Windows
//   4. a wiring guard on src/index.js, since no test on a POSIX CI can observe
//      the real rsync argv (ssh_sync opens an SSH connection first)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toRsyncLocalPath } from '../src/rsync-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${label}`); passed++; }

const cwd = 'C:\\mcp\\mcp-ssh-manager';
const windowsPath = (value) => toRsyncLocalPath(value, { platform: 'win32', cwd });

// ── 1. Known conversions ─────────────────────────────────────────────────────

const cases = [
  [
    'absolute drive path',
    'C:\\Users\\Administrator\\project\\file.txt',
    '/c/Users/Administrator/project/file.txt',
  ],
  ['forward-slash drive path', 'D:/data/file.txt', '/d/data/file.txt'],
  ['relative path stays relative', '.\\package.json', './package.json'],
  ['relative directory keeps trailing slash', '.\\src\\', './src/'],
  ['parent-relative path stays relative', '..\\sibling\\file.txt', '../sibling/file.txt'],
  [
    'drive-relative path is made unambiguous',
    'C:package.json',
    '/c/mcp/mcp-ssh-manager/package.json',
  ],
  ['drive root', 'C:\\', '/c/'],
  ['UNC path', '\\\\server\\share\\folder\\', '//server/share/folder/'],
  ['UNC path with a $ share', '\\\\wsl$\\Ubuntu\\home', '//wsl$/Ubuntu/home'],
  ['extended drive path', '\\\\?\\C:\\data\\file.txt', '/c/data/file.txt'],
  ['extended UNC path', '\\\\?\\UNC\\server\\share\\file.txt', '//server/share/file.txt'],
  ['spaces remain unescaped for spawn arguments', 'C:\\My Files\\a.txt', '/c/My Files/a.txt'],
  // A path rooted on the current drive is NOT already an MSYS2 mount: its first
  // segment is a real directory name, so it still has to be converted.
  ['rooted path resolves against the current drive', '/Users/me/data', '/c/Users/me/data'],
  ['bare root resolves to the current drive', '/', '/c/'],
];

for (const [name, input, expected] of cases) {
  assert.equal(windowsPath(input), expected, name);
  ok(name);
}

// ── 2. Already-MSYS2 paths are passed through ────────────────────────────────
//
// Windows users worked around this very bug by pre-converting their paths, and
// on a pull there is no fs.existsSync() check to stop them. Resolving those
// against the current drive would turn /c/project into /c/c/project — one
// broken path traded for another, silently writing to the wrong place.

const alreadyConverted = [
  ['drive mount', '/c/project'],
  ['drive mount with trailing slash', '/c/project/'],
  ['bare drive mount', '/c'],
  ['uppercase drive mount', '/C/project'],
  ['UNC share', '//server/share/folder'],
];

for (const [name, input] of alreadyConverted) {
  assert.equal(windowsPath(input), input, `${name} must be passed through unchanged`);
  ok(`already-MSYS2 ${name} is left untouched`);
}

// ── 3. Invariants that must hold for any Windows input ───────────────────────

const everyWindowsInput = [
  ...cases.map(([, input]) => input),
  ...alreadyConverted.map(([, input]) => input),
];

for (const input of everyWindowsInput) {
  const converted = windowsPath(input);

  // The whole point: rsync must never see a drive-colon, or it treats the
  // prefix as a remote host and tries to SSH into a host named "c".
  assert.ok(
    !/^[A-Za-z]:/.test(converted),
    `converted path must not start with a drive letter: ${input} → ${converted}`
  );
  // A backslash would be read as an escape by rsync's argument parsing.
  assert.ok(
    !converted.includes('\\'),
    `converted path must not contain a backslash: ${input} → ${converted}`
  );
  // Converting an already-converted path must be a no-op, otherwise a future
  // caller that converts twice quietly corrupts the path.
  assert.equal(
    windowsPath(converted),
    converted,
    `conversion must be idempotent: ${input} → ${converted} → ${windowsPath(converted)}`
  );
  // Trailing separators carry rsync's "contents of this directory" semantics
  // and must survive in both directions.
  assert.equal(
    converted.endsWith('/'),
    /[\\/]$/.test(input),
    `trailing separator semantics must be preserved: ${input} → ${converted}`
  );
}
ok(`invariants hold for all ${everyWindowsInput.length} Windows inputs (no drive-colon, no backslash, idempotent, trailing separator preserved)`);

// ── 4. Platform isolation ────────────────────────────────────────────────────
//
// Every non-Windows host must be completely unaffected: same string in, same
// string out, including the shapes that would otherwise be rewritten.

for (const platform of /** @type {NodeJS.Platform[]} */ (['linux', 'darwin', 'freebsd'])) {
  for (const input of ['/var/data/file.txt', 'C:\\project', './rel', '', '//server/share']) {
    assert.equal(
      toRsyncLocalPath(input, { platform, cwd: '/work' }),
      input,
      `${platform} must pass "${input}" through untouched`
    );
  }
}
ok('non-Windows platforms pass every path through untouched, including empty');

// ── 5. Failure modes ─────────────────────────────────────────────────────────

assert.throws(
  () => windowsPath(''),
  /Local rsync path cannot be empty/,
  'empty Windows destinations do not silently become the working directory'
);
ok('empty Windows destinations fail clearly');

assert.throws(
  () => windowsPath('\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\file.txt'),
  /Unsupported Windows device path/,
  'unsupported Windows device namespaces fail clearly'
);
ok('unsupported Windows device namespaces fail clearly');

// ── 6. Wiring guard on src/index.js ──────────────────────────────────────────
//
// The conversion is worthless if ssh_sync stops using it, and that cannot be
// observed from a test here: the handler opens a real SSH connection before
// spawning rsync, and on a POSIX CI the conversion is the identity anyway. So
// assert the wiring statically — the same approach test-config-field-names.js
// uses to forbid stale field reads.

const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');

assert.match(
  indexSource,
  /import \{ toRsyncLocalPath \} from '\.\/rsync-path\.js';/,
  'src/index.js must import toRsyncLocalPath'
);
assert.match(
  indexSource,
  /const rsyncLocalPath = toRsyncLocalPath\(localPath\);/,
  'ssh_sync must derive the rsync path from the native local path'
);

const rsyncArgPushes = indexSource.match(/rsyncArgs\.push\((localPath|rsyncLocalPath)\)/g) || [];
assert.equal(rsyncArgPushes.length, 2, 'ssh_sync passes exactly two local-path arguments to rsync (push and pull)');
assert.ok(
  rsyncArgPushes.every((line) => line.includes('rsyncLocalPath')),
  `rsync must receive the converted path, not the native one: found ${rsyncArgPushes.join(', ')}`
);

// The mirror image: Node's filesystem checks must keep the native path, or
// fs.existsSync() would test /c/project on a Windows host and always fail.
assert.ok(
  !/existsSync\(rsyncLocalPath\)/.test(indexSource),
  'filesystem checks must use the native Windows path, never the rsync one'
);
assert.match(
  indexSource,
  /if \(!fs\.existsSync\(localPath\)\)/,
  'ssh_sync must still check the native local path on disk'
);
ok('ssh_sync wiring: rsync gets the converted path, fs checks keep the native one');

console.log(`\n✅ rsync-path tests: ${passed} passed, 0 failed`);
