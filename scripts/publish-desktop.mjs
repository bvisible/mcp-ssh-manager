#!/usr/bin/env node
// The only desktop upload step. Runs in a separate job after every OS passed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseVersion } from './release-version.mjs';

export function verifyArtifacts(directory, version, expectedCommit = null) {
  const files = [];
  for (const platform of ['darwin', 'win32', 'linux']) {
    const manifestPath = path.join(directory, `release-manifest-${platform}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.platform, platform);
    if (expectedCommit) assert.equal(manifest.commit, expectedCommit, 'Git tag changed after the build');
    for (const item of manifest.files) {
      assert.equal(path.basename(item.name), item.name);
      const file = path.join(directory, item.name);
      assert.equal(fs.statSync(file).size, item.size);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), item.sha256, `Artifact changed after validation: ${item.name}`);
      files.push(file);
    }
    files.push(manifestPath);
  }
  assert.equal(new Set(files).size, files.length, 'Different platforms have colliding filenames');
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const release = releaseVersion(version, process.env.RELEASE_TAG);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files = verifyArtifacts(process.argv[2], version, commit);
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const existing = JSON.parse(gh(['release', 'view', release.tag, '--json', 'isDraft,isPrerelease']));
  assert.equal(existing.isDraft, true, 'Refuse to replace assets of an already public release; publish a new version');
  assert.equal(existing.isPrerelease, release.prerelease, 'GitHub release channel differs from package version');
  gh(['release', 'upload', release.tag, ...files, '--clobber']);
  gh(['release', 'edit', release.tag, '--draft=false', `--prerelease=${release.prerelease}`, `--latest=${!release.prerelease}`]);
}
