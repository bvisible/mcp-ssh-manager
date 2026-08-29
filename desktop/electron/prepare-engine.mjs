/**
 * Assemble what the packaged app actually needs from the engine.
 *
 * Pointing electron-builder straight at the repository's `node_modules` looked
 * simpler and put 55 MB of eslint, acorn, ajv and a Rust resolver binary inside
 * the application — devDependencies have no business shipping to a user.
 * `npm install --omit=dev` against a copied package.json is the only reliable
 * way to get the production tree, since the two are intertwined on disk.
 *
 * Run by `npm run build:*` before electron-builder.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const out = path.join(here, 'engine');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The interface has to exist: without it the app starts and shows the
// "not built" fallback, which would be a strange thing to ship.
const ui = path.join(repo, 'dist', 'ui', 'index.html');
if (!fs.existsSync(ui)) {
  console.error('dist/ui is missing — run `npm run build:ui` from the repository root first.');
  process.exit(1);
}

for (const entry of ['src', 'cli', 'skills']) {
  const from = path.join(repo, entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, entry), { recursive: true });
}
fs.cpSync(path.join(repo, 'dist', 'ui'), path.join(out, 'dist', 'ui'), { recursive: true });

// package.json without the dev half, so `npm install` below resolves only what
// the engine needs at runtime. The lockfile comes along so the versions match
// what was tested rather than whatever is newest today.
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.copyFileSync(path.join(repo, 'package-lock.json'), path.join(out, 'package-lock.json'));

console.log('Installing the engine’s production dependencies…');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
  cwd: out,
  stdio: 'inherit',
});

// --ignore-scripts above skips ssh2's optional native build. That is deliberate:
// those bindings are accelerators, ssh2 falls back to pure JavaScript without
// them, and building them here would produce a binary for this machine's
// architecture inside an app that may be cross-built for another.
const size = execFileSync('du', ['-sh', out]).toString().split('\t')[0];
console.log(`Engine ready: ${size} in ${path.relative(repo, out)}`);
