import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseVersion } from '../scripts/release-version.mjs';
import { finalizeArtifacts, digest } from '../desktop/electron/finalize-artifacts.mjs';
import { verifyArtifacts } from '../scripts/publish-desktop.mjs';

assert.equal(releaseVersion('4.0.0', 'v4.0.0').npmTag, 'latest');
for (const version of ['4.0.0-rc.1', '4.0.0-beta.2', '4.1.0-next.0']) {
  const result = releaseVersion(version, `v${version}`);
  assert.equal(result.npmTag, 'next');
  assert.equal(result.prerelease, true);
  assert.notEqual(result.channel, 'latest');
}
assert.throws(() => releaseVersion('4.0.0', 'v4'), /exact version tag/);
assert.throws(() => releaseVersion('4.0.0-rc.1', 'v4.0.0'), /exact version tag/);
assert.throws(() => releaseVersion('4.0.0-1'), /named prerelease/);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-release-test-'));
const yaml = { load: JSON.parse, dump: data => JSON.stringify(data) };
try {
  // What electron-builder actually writes for the GitHub provider: the
  // `latest` channel files, for a prerelease too. The first version of this
  // test invented `rc-mac.yml`, agreed with a script that expected it, and both
  // were wrong — the first real prerelease build failed on it.
  const version = '4.0.0-beta.1';
  for (const [platform, suffixes, feed] of [
    ['darwin', ['arm64.zip', 'x64.zip', 'arm64.dmg', 'x64.dmg'], 'latest-mac.yml'],
    ['win32', ['setup.exe'], 'latest.yml'],
    ['linux', ['x64.AppImage', 'x64.deb'], 'latest-linux.yml'],
  ]) {
    const dir = path.join(scratch, platform);
    fs.mkdirSync(dir);
    const names = suffixes.map(suffix => `SSH Manager-${version}-${suffix}`);
    for (const name of names) fs.writeFileSync(path.join(dir, name), `final signed bytes ${name}`);
    fs.writeFileSync(path.join(dir, feed), JSON.stringify({ version, files: names.map(name => ({ url: name.replace(/ /g, '-'), sha512: 'before-stapling', size: 1 })) }));
    const manifest = await finalizeArtifacts(dir, version, platform, { yaml, rebuildBlockmaps: false });
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, feed)));
    for (const file of metadata.files) {
      assert.equal(file.sha512, digest(path.join(dir, file.url)), 'feed must hash final signed/stapled bytes');
      assert.equal(file.size, fs.statSync(path.join(dir, file.url)).size);
    }
    assert.equal(metadata.path, metadata.files[0].url);
    assert.equal(manifest.version, version);
    for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(scratch, name));
  }
  const files = verifyArtifacts(scratch, version);
  assert.ok(files.length >= 10);
  assert.throws(() => verifyArtifacts(scratch, '4.0.0'), /4.0.0/);
  const victim = files.find(file => file.endsWith('.dmg'));
  fs.appendFileSync(victim, ' changed after verification');
  assert.throws(() => verifyArtifacts(scratch, version), /Expected values/);

  // A channel-named file is not what the GitHub provider publishes, and an
  // updater could be pointed at the wrong one.
  const rejected = path.join(scratch, 'wrong-channel');
  fs.mkdirSync(rejected);
  fs.writeFileSync(path.join(rejected, 'beta.yml'), '{}');
  await assert.rejects(() => finalizeArtifacts(rejected, version, 'win32', { yaml, rebuildBlockmaps: false }), /Unexpected update metadata/);

  // An `rc` desktop build would strand its users: electron-updater only moves
  // alpha and beta builds on to a stable release.
  await assert.rejects(() => finalizeArtifacts(rejected, '4.0.0-rc.1', 'win32', { yaml, rebuildBlockmaps: false }), /alpha or beta/);
  console.log('Release channels, exact version tags, final artifact hashes and tamper detection passed.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
