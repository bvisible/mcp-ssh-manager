// Regression tests for Windows local paths passed to MSYS2 rsync.
//
// rsync treats the colon in an unmodified path such as C:\work\file.txt as a
// remote-host separator. The MCP keeps that native path for Node filesystem
// checks, then converts only the spawned rsync argument to /c/work/file.txt.
import assert from 'node:assert/strict';
import { toRsyncLocalPath } from '../src/rsync-path.js';

const cwd = 'C:\\mcp\\mcp-ssh-manager';
const windowsPath = (value) => toRsyncLocalPath(value, { platform: 'win32', cwd });

const cases = [
  [
    'absolute drive path',
    'C:\\Users\\Administrator\\project\\file.txt',
    '/c/Users/Administrator/project/file.txt',
  ],
  ['forward-slash drive path', 'D:/data/file.txt', '/d/data/file.txt'],
  ['relative path stays relative', '.\\package.json', './package.json'],
  ['relative directory keeps trailing slash', '.\\src\\', './src/'],
  [
    'drive-relative path is made unambiguous',
    'C:package.json',
    '/c/mcp/mcp-ssh-manager/package.json',
  ],
  ['drive root', 'C:\\', '/c/'],
  ['UNC path', '\\\\server\\share\\folder\\', '//server/share/folder/'],
  ['extended drive path', '\\\\?\\C:\\data\\file.txt', '/c/data/file.txt'],
  ['extended UNC path', '\\\\?\\UNC\\server\\share\\file.txt', '//server/share/file.txt'],
  ['spaces remain unescaped for spawn arguments', 'C:\\My Files\\a.txt', '/c/My Files/a.txt'],
];

for (const [name, input, expected] of cases) {
  assert.equal(windowsPath(input), expected, name);
  console.log(`\x1b[32m✓\x1b[0m ${name}`);
}

assert.equal(
  toRsyncLocalPath('/var/data/file.txt', { platform: 'linux', cwd: '/work' }),
  '/var/data/file.txt',
  'non-Windows paths stay unchanged'
);
console.log('\x1b[32m✓\x1b[0m non-Windows paths stay unchanged');

assert.throws(
  () => windowsPath(''),
  /Local rsync path cannot be empty/,
  'empty Windows destinations do not silently become the working directory'
);
console.log('\x1b[32m✓\x1b[0m empty Windows destinations fail clearly');

assert.throws(
  () => windowsPath('\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\file.txt'),
  /Unsupported Windows device path/,
  'unsupported Windows device namespaces fail clearly'
);
console.log('\x1b[32m✓\x1b[0m unsupported Windows device namespaces fail clearly');

console.log(`\n✅ rsync-path tests: ${cases.length + 3} passed, 0 failed`);
