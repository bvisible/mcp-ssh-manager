import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

  // The interface is generated, never committed. What reaches users is unchanged
  // (the package and the app carry the built interface); these guards keep it so.
  const root = new URL('..', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.scripts.prepack, 'node scripts/build-interface.mjs', 'the package must build the interface when it is packed');
  assert.equal(manifest.scripts['build:ui'], manifest.scripts.prepack, 'build:ui and prepack must be the same build');
  const npmignore = fs.readFileSync(new URL('.npmignore', root), 'utf8').split('\n').map(line => line.trim());
  assert.ok(npmignore.includes('!dist/ui/**'), '.npmignore must let the built interface into the package');
  assert.ok(npmignore.includes('ui/'), 'the interface sources must stay out of the package');
  const gitignore = fs.readFileSync(new URL('.gitignore', root), 'utf8').split('\n').map(line => line.trim());
  assert.ok(gitignore.includes('dist/') && !gitignore.includes('!dist/ui/'), 'dist/ is generated and must be ignored, dist/ui included');
  const tracked = spawnSync('git', ['ls-files', 'dist'], { cwd: fileURLToPath(root), encoding: 'utf8' });
  if (tracked.status === 0) assert.equal(tracked.stdout.trim(), '', 'no generated output may be tracked by git');
  for (const workflow of ['test.yml', 'release.yml', 'release-desktop.yml']) {
    const text = fs.readFileSync(new URL(`.github/workflows/${workflow}`, root), 'utf8');
    assert.ok(!/git diff --exit-code -- dist\/ui/.test(text), `${workflow} must not compare against a committed interface`);
  }
  console.log('The interface is generated at packaging: prepack builds it, nothing generated is tracked, the package still ships it.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
