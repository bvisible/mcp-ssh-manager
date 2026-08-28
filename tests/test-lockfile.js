// Guards the committed npm lockfile (PR #60). The lockfile only buys us
// reproducible installs and a supply-chain audit trail as long as it stays in
// sync with package.json and keeps pointing at the public registry, so this
// test locks four things that would otherwise rot silently:
//
//   1. it is committed and not re-ignored (the .gitignore entry PR #60 removed)
//   2. its version and dependency ranges match package.json — the release
//      checklist now has one more version spot, and forgetting it makes
//      `npm ci` fail for everyone instead of just being untidy
//   3. every package resolves to registry.npmjs.org with an integrity hash,
//      and no entry is a file:/git+/link: escape hatch
//   4. the set of packages allowed to run install scripts stays explicit —
//      a new one appearing is a supply-chain event worth a human look
//   5. no runtime dependency quietly requires a newer Node than package.json
//      advertises — auditing the transitive tree is only possible because the
//      lockfile pins it
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');
const PKG_PATH = path.join(ROOT, 'package.json');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

// Packages allowed to run install scripts. ssh2 optionally builds cpu-features
// for its native crypto fast paths; both are expected. Anything else showing up
// here means a new dependency gained the ability to run code at install time.
const ALLOWED_INSTALL_SCRIPTS = new Set(['ssh2', 'cpu-features']);

// Runtime packages known to declare a higher engines.node than we advertise,
// with the reason they are tolerated. Keep this table short and re-check every
// entry when its parent dependency is bumped.
const ENGINE_EXCEPTIONS = {
  '@hono/node-server':
    'pulled by @modelcontextprotocol/sdk for its HTTP/SSE transport only; the stdio '
    + 'server this package ships never imports it, and Node 18 installs and tests green. '
    + 'Re-check when bumping @modelcontextprotocol/sdk.'
};

const REGISTRY = 'https://registry.npmjs.org/';

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

function testLockfileIsCommitted() {
  assert.ok(fs.existsSync(LOCK_PATH), 'package-lock.json must exist at the repo root');
  ok('package-lock.json exists at the repo root');

  // The .gitignore entry PR #60 removed must not come back: an ignored lockfile
  // is a lockfile that silently stops being updated by contributors.
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const ignoresLock = gitignore
    .split('\n')
    .map(line => line.trim())
    .some(line => line === 'package-lock.json' || line === '/package-lock.json');
  assert.ok(!ignoresLock, '.gitignore must not list package-lock.json');
  ok('.gitignore does not re-ignore package-lock.json');

  // Tracked-in-git check, skipped outside a working clone (npm tarballs ship no
  // tests/, but a user may still run this from an exported directory).
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'], {
      cwd: ROOT, stdio: 'pipe'
    });
    ok('package-lock.json is tracked by git');
  } catch {
    console.log('\x1b[33m~\x1b[0m  git tracking check skipped (not a git working copy)');
  }
}

function testLockfileShape(lock) {
  assert.strictEqual(lock.name, pkg.name, 'lockfile name must match package.json');
  // lockfileVersion 3 is what npm 7+ writes; v1 has no integrity-per-package
  // tree and would defeat the point of committing it.
  assert.ok(lock.lockfileVersion >= 3, `lockfileVersion must be >= 3, got ${lock.lockfileVersion}`);
  assert.ok(lock.packages && lock.packages[''], 'lockfile must contain a root package entry');
  ok(`lockfile is v${lock.lockfileVersion} and names ${lock.name}`);
}

function testVersionsAreInSync(lock) {
  // Two spots carry the version. `npm version` updates both; a hand-edited
  // release updates neither, and `npm ci` then refuses to install.
  assert.strictEqual(lock.version, pkg.version,
    `lockfile .version (${lock.version}) must match package.json (${pkg.version})`);
  assert.strictEqual(lock.packages[''].version, pkg.version,
    `lockfile .packages[""].version (${lock.packages[''].version}) must match package.json (${pkg.version})`);
  ok(`lockfile version matches package.json in both spots (${pkg.version})`);
}

function testDependencyRangesAreInSync(lock) {
  const root = lock.packages[''];
  for (const field of ['dependencies', 'devDependencies']) {
    assert.deepStrictEqual(root[field] ?? {}, pkg[field] ?? {},
      `lockfile root ${field} must match package.json — regenerate with \`npm install --package-lock-only\``);
  }
  ok('lockfile root dependency ranges match package.json (deps + devDeps)');
}

// Minimal semver range check covering the forms this project actually uses.
// Anything else is reported rather than silently treated as satisfied.
function satisfies(version, range) {
  const parse = v => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const v = parse(version);
  const operator = /^[\^~]/.test(range) ? range[0] : '=';
  const base = parse(range.replace(/^[\^~]/, ''));
  if (!v || !base) return { supported: false };

  const gte = v[0] > base[0]
    || (v[0] === base[0] && (v[1] > base[1] || (v[1] === base[1] && v[2] >= base[2])));
  if (!gte) return { supported: true, satisfied: false };

  if (operator === '=') return { supported: true, satisfied: version === range };
  if (operator === '~') return { supported: true, satisfied: v[0] === base[0] && v[1] === base[1] };
  // Caret: the leftmost non-zero component is the one that may not change.
  if (base[0] !== 0) return { supported: true, satisfied: v[0] === base[0] };
  if (base[1] !== 0) return { supported: true, satisfied: v[0] === 0 && v[1] === base[1] };
  return { supported: true, satisfied: v[0] === 0 && v[1] === 0 && v[2] === base[2] };
}

function testDirectDependenciesSatisfyTheirRanges(lock) {
  const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const unsupported = [];
  for (const [name, range] of Object.entries(declared)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} declared in package.json but missing from the lockfile`);
    const result = satisfies(entry.version, range);
    if (!result.supported) { unsupported.push(`${name}@${range}`); continue; }
    assert.ok(result.satisfied,
      `${name}: locked ${entry.version} does not satisfy the declared range ${range}`);
  }
  assert.deepStrictEqual(unsupported, [],
    `range forms not understood by this test (extend satisfies()): ${unsupported.join(', ')}`);
  ok(`every direct dependency resolves inside its declared range (${Object.keys(declared).length} checked)`);
}

function testEveryPackageComesFromTheRegistry(lock) {
  const offenders = [];
  const missingIntegrity = [];
  const localLinks = [];
  let count = 0;

  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '') continue;
    count++;
    if (entry.link) { localLinks.push(name); continue; }
    if (!entry.resolved) { offenders.push(`${name}: no resolved URL`); continue; }
    if (!entry.resolved.startsWith(REGISTRY)) offenders.push(`${name} -> ${entry.resolved}`);
    if (!entry.integrity) missingIntegrity.push(name);
  }

  assert.deepStrictEqual(offenders, [],
    `packages not resolved from ${REGISTRY}:\n${offenders.join('\n')}`);
  ok(`all ${count} locked packages resolve to registry.npmjs.org`);

  assert.deepStrictEqual(missingIntegrity, [],
    `packages without an integrity hash:\n${missingIntegrity.join('\n')}`);
  ok('every locked package carries an integrity hash');

  assert.deepStrictEqual(localLinks, [],
    `local link: entries have no place in a published package:\n${localLinks.join('\n')}`);
  ok('no file:/link: entries in the tree');
}

function testInstallScriptsAreExpected(lock) {
  const withScripts = [];
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '' || !entry.hasInstallScript) continue;
    withScripts.push(name.replace(/^(?:.*\/)?node_modules\//, ''));
  }
  const unexpected = withScripts.filter(name => !ALLOWED_INSTALL_SCRIPTS.has(name));
  assert.deepStrictEqual(unexpected, [],
    `new dependencies run install scripts — review them, then add to ALLOWED_INSTALL_SCRIPTS: ${unexpected.join(', ')}`);
  ok(`install scripts limited to the reviewed set (${withScripts.join(', ') || 'none'})`);
}

// Lowest major version accepted by a semver range, across `||` alternatives.
// Returns null for shapes this helper does not understand, so callers can
// surface them instead of assuming they pass.
function lowestAcceptedMajor(range) {
  const majors = range
    .split('||')
    .map(clause => /(\d+)/.exec(clause))
    .map(match => (match ? Number(match[1]) : null));
  if (majors.some(major => major === null)) return null;
  return Math.min(...majors);
}

function testRuntimeEnginesMatchOurClaim(lock) {
  const ours = lowestAcceptedMajor(pkg.engines?.node ?? '');
  assert.ok(ours !== null, `package.json engines.node must be parseable, got ${pkg.engines?.node}`);

  const tooNew = [];
  const unparsed = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.dev || !entry.engines?.node) continue;
    const name = key.replace(/^(?:.*\/)?node_modules\//, '');
    const required = lowestAcceptedMajor(entry.engines.node);
    if (required === null) { unparsed.push(`${name}: ${entry.engines.node}`); continue; }
    if (required > ours && !(name in ENGINE_EXCEPTIONS)) {
      tooNew.push(`${name}@${entry.version} needs node ${entry.engines.node}, we advertise ${pkg.engines.node}`);
    }
  }

  assert.deepStrictEqual(unparsed, [], `engine ranges not understood:\n${unparsed.join('\n')}`);
  assert.deepStrictEqual(tooNew, [],
    `runtime dependencies outrun package.json engines.node — raise engines, drop the dependency, `
    + `or document it in ENGINE_EXCEPTIONS:\n${tooNew.join('\n')}`);
  ok(`no runtime dependency outruns engines.node (${pkg.engines.node}, ${Object.keys(ENGINE_EXCEPTIONS).length} documented exception(s))`);
}

function main() {
  testLockfileIsCommitted();
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  testLockfileShape(lock);
  testVersionsAreInSync(lock);
  testDependencyRangesAreInSync(lock);
  testDirectDependenciesSatisfyTheirRanges(lock);
  testEveryPackageComesFromTheRegistry(lock);
  testInstallScriptsAreExpected(lock);
  testRuntimeEnginesMatchOurClaim(lock);
  console.log(`\n✅ lockfile tests passed (${passed} checks)`);
}

main();
