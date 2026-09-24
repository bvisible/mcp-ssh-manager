#!/usr/bin/env node
// Called after signing/stapling. Hash the final bytes, regenerate the DMG's
// differential map, and record exactly which files may be published.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { releaseVersion } from '../../scripts/release-version.mjs';
const require = createRequire(import.meta.url);

const artifact = /\.(?:zip|dmg|exe|AppImage|deb|blockmap)$/;
export const digest = (file, algorithm = 'sha512') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex');

// The update metadata electron-builder writes for the GitHub provider. It is
// always the `latest` channel, prerelease or not: app-builder-lib's
// computeChannelNames() returns the configured channel (default `latest`) for
// GitHub, because a prerelease is expressed by the GitHub release flag rather
// than by a channel file. electron-updater follows suit: a prerelease build
// asks for `<channel>-mac.yml` first and falls back to `latest-mac.yml` on a
// 404 (GitHubProvider, 6.8.9). Expecting `beta-mac.yml` here refused the files
// the first real prerelease build produced.
const UPDATE_METADATA = { darwin: 'latest-mac.yml', win32: 'latest.yml', linux: 'latest-linux.yml' };

// Only these prerelease names can reach the stable release by themselves.
// electron-updater lets an alpha or beta build take the newest release in the
// feed, stable included; any other name (`rc`, `next`) is a custom channel
// that only ever follows its own kind, so everyone who installed an `rc`
// would stay on it after 4.0.0 shipped, waiting for an `rc` that never comes.
const DESKTOP_PRERELEASE_CHANNELS = ['alpha', 'beta'];

export async function finalizeArtifacts(dir, version, platform, { rebuildBlockmaps = true, yaml = null } = {}) {
  const { prerelease, channel } = releaseVersion(version);
  assert.ok(!prerelease || DESKTOP_PRERELEASE_CHANNELS.includes(channel),
    `Desktop prereleases must be alpha or beta, not "${channel}": electron-updater never moves any other prerelease on to a stable release`);
  const { load, dump } = yaml || require('js-yaml');
  for (const file of fs.readdirSync(dir).filter(name => artifact.test(name))) {
    const safe = file.replace(/ /g, '-');
    if (safe !== file) {
      assert.equal(fs.existsSync(path.join(dir, safe)), false, `Duplicate artifact ${safe}`);
      fs.renameSync(path.join(dir, file), path.join(dir, safe));
    }
  }
  if (rebuildBlockmaps) {
    const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js');
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.dmg'))) {
      await buildBlockMap(path.join(dir, file), 'gzip', path.join(dir, `${file}.blockmap`));
    }
  }
  const metadataFiles = fs.readdirSync(dir).filter(name => /\.yml$/.test(name) && !name.startsWith('builder-'));
  assert.ok(metadataFiles.length, 'No updater metadata was built');
  assert.deepEqual(metadataFiles, [UPDATE_METADATA[platform]], `Unexpected update metadata: ${metadataFiles.join(', ')}`);
  for (const file of metadataFiles) {
    const metadata = load(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(metadata.version, version, 'Updater metadata version mismatch');
    assert.ok(metadata.files?.length, 'Updater metadata has no files');
    for (const entry of metadata.files) {
      const name = decodeURIComponent(entry.url).replace(/ /g, '-');
      assert.equal(path.basename(name), name, 'Artifact path must be a filename');
      const full = path.join(dir, name);
      entry.url = name;
      entry.sha512 = digest(full);
      entry.size = fs.statSync(full).size;
    }
    metadata.path = metadata.files[0].url;
    metadata.sha512 = metadata.files[0].sha512;
    fs.writeFileSync(path.join(dir, file), dump(metadata, { lineWidth: -1 }));
  }
  const files = fs.readdirSync(dir).filter(name => artifact.test(name) || metadataFiles.includes(name)).sort();
  const expected = platform === 'darwin' ? ['arm64.dmg', 'x64.dmg', 'arm64.zip', 'x64.zip']
    : platform === 'win32' ? ['setup.exe'] : ['.AppImage', '.deb'];
  for (const suffix of expected) assert.ok(files.some(name => name.endsWith(suffix)), `Missing ${suffix}`);
  for (const file of files.filter(name => artifact.test(name))) assert.ok(file.includes(version), `Wrong-version artifact: ${file}`);
  const manifest = { version, platform, commit: process.env.RELEASE_COMMIT || null, files: files.map(name => ({ name, size: fs.statSync(path.join(dir, name)).size, sha256: digest(path.join(dir, name), 'sha256') })) };
  fs.writeFileSync(path.join(dir, `release-manifest-${platform}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const version = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))).version;
  console.log(await finalizeArtifacts(process.argv[2] || 'dist', version, process.platform));
}
