// The download counts behind the README badges: what is counted, what is not,
// and how a number is written. No network: the release list is a fixture.
import assert from 'node:assert/strict';
import { badge, classifyAsset, compact, summarize } from '../scripts/download-stats.mjs';

let passed = 0;
const ok = label => { passed++; console.log(`\x1b[32m✓\x1b[0m ${passed}. ${label}`); };

assert.equal(classifyAsset('SSH-Manager-4.1.0-arm64.dmg'), 'installer');
assert.equal(classifyAsset('SSH-Manager-4.1.0-setup.exe'), 'installer');
assert.equal(classifyAsset('SSH-Manager-4.1.0-x86_64.AppImage'), 'installer');
assert.equal(classifyAsset('SSH-Manager-4.1.0-amd64.deb'), 'installer');
assert.equal(classifyAsset('SSH-Manager-4.1.0-arm64.zip'), 'appUpdate');
assert.equal(classifyAsset('mcp-ssh-manager-4.0.0-beta.1.tgz'), 'tarball');
ok('installers, macOS update archives and package tarballs are recognised');

for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) assert.equal(classifyAsset(name), 'updateFeed');
for (const name of ['SSH-Manager-4.1.0-arm64.dmg.blockmap', 'SSH-Manager-4.1.0-setup.exe.blockmap',
  'release-manifest-darwin.json', 'sbom.cyclonedx.json']) assert.equal(classifyAsset(name), 'other');
ok('update feeds, blockmaps, manifests and the SBOM are not downloads of the product');

const releases = [
  { assets: [
    { name: 'SSH-Manager-4.1.0-arm64.dmg', download_count: 10 },
    { name: 'SSH-Manager-4.1.0-setup.exe', download_count: 7 },
    { name: 'SSH-Manager-4.1.0-arm64.zip', download_count: 5 },
    { name: 'latest-mac.yml', download_count: 900 },
    { name: 'SSH-Manager-4.1.0-arm64.zip.blockmap', download_count: 40 },
  ] },
  { assets: [
    { name: 'mcp-ssh-manager-4.0.0-beta.1.tgz', download_count: 3 },
    { name: 'SSH-Manager-4.0.0-amd64.deb', download_count: 2 },
  ] },
  { assets: [] },
];
const summary = summarize({ npm: 1000, releases });
assert.deepEqual(summary.github, { installer: 19, appUpdate: 5, tarball: 3, updateFeed: 900, other: 40 });
assert.equal(summary.desktop, 24);
assert.equal(summary.total, 1027);
ok('the total adds npm, the desktop app and the tarballs, and leaves out 940 update checks and blockmaps');

for (const [n, text] of [[0, '0'], [423, '423'], [999, '999'], [1000, '1k'], [1234, '1.2k'], [9949, '9.9k'],
  [9950, '10k'], [46243, '46k'], [999499, '999k'], [999500, '1M'], [1250000, '1.3M'], [12_400_000, '12M']]) {
  assert.equal(compact(n), text, `${n}`);
}
ok('numbers are written like shields.io writes them');

assert.deepEqual(badge('downloads', 46243), { schemaVersion: 1, label: 'downloads', message: '46k', color: 'c04500' });
ok('the badge file follows the shields.io endpoint schema');

console.log(`\n✅ download stats tests passed (${passed} checks)`);
