#!/usr/bin/env node
// Builds the control plane interface into dist/ui.
//
// dist/ui is generated, never committed: it is built when the npm package is
// made (`prepack`), when the desktop app is assembled (prepare-engine) and by
// hand with `npm run build:ui`. What a user installs is unchanged: the package
// and the app carry the built interface, so nothing compiles on their machine.
//
// The interface sources live in ui/ and are not part of the package, so a tree
// without ui/ (an unpacked tarball) keeps the dist/ui it already has.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(root, 'ui');
const out = path.join(root, 'dist', 'ui');
const REQUIRED = ['index.html', 'app.js', 'app.css'];

/** What is missing from a build, empty when it is complete. */
function missingFrom(dir) {
  return REQUIRED.filter(name => {
    try { return fs.statSync(path.join(dir, name)).size === 0; } catch { return true; }
  });
}

/**
 * Run npm without a shell. `npm_execpath` is npm's own script when this file is
 * started by `npm run`; Windows has no `npm` binary, only `npm.cmd`, which Node
 * will not spawn without a shell.
 * @param {string[]} args
 */
function npm(args) {
  const cli = process.env.npm_execpath;
  // Everything is written to stderr: as `prepack` this runs inside `npm pack`,
  // whose stdout may be machine-read (`npm pack --json`) and must stay clean.
  const stdio = ['ignore', process.stderr.fd, process.stderr.fd];
  if (cli && cli.endsWith('.js')) {
    execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio });
  } else {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, stdio, shell: process.platform === 'win32' });
  }
}

if (!fs.existsSync(path.join(ui, 'package.json'))) {
  const missing = missingFrom(out);
  if (missing.length) {
    console.error(`The interface sources (ui/) are not here and dist/ui is incomplete (missing: ${missing.join(', ')}).`);
    process.exit(1);
  }
  console.error('No interface sources here; keeping the dist/ui that comes with this tree.');
  process.exit(0);
}

// A pack from a fresh checkout has no ui/node_modules yet; the lockfile decides
// what gets installed, exactly as in CI.
if (!fs.existsSync(path.join(ui, 'node_modules'))) {
  console.error('Installing the interface dependencies from ui/package-lock.json…');
  npm(['ci', '--prefix', 'ui', '--no-audit', '--no-fund']);
}

// Never ship a stale or half-written build: start from nothing.
fs.rmSync(out, { recursive: true, force: true });
console.error('Building the interface into dist/ui…');
npm(['run', 'build', '--prefix', 'ui']);

const missing = missingFrom(out);
if (missing.length) {
  console.error(`The interface build did not produce: ${missing.join(', ')}`);
  process.exit(1);
}
console.error('dist/ui is ready.');
