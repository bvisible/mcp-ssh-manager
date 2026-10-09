#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function releaseVersion(version, tag) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-([a-z][a-z0-9-]*)(?:\.[0-9A-Za-z-]+)*)?$/, 'Release version must be stable or a named prerelease');
  if (tag !== undefined) assert.equal(tag, `v${version}`, 'Publication requires the exact version tag');
  const prerelease = version.includes('-');
  return { version, tag: `v${version}`, prerelease, npmTag: prerelease ? 'next' : 'latest', channel: prerelease ? version.slice(version.indexOf('-') + 1).split('.')[0] : 'latest' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const version = read('package.json').version;
  const release = releaseVersion(version, process.env.RELEASE_REQUIRE_TAG === 'true' ? process.env.RELEASE_TAG : undefined);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (process.env.RELEASE_REQUIRE_TAG === 'true') {
    const taggedCommit = execFileSync('git', ['rev-parse', `refs/tags/${release.tag}^{commit}`], { encoding: 'utf8' }).trim();
    assert.equal(taggedCommit, commit, 'Publication requires checkout of the exact Git tag');
  }
  for (const file of ['package-lock.json', 'desktop/electron/package.json', 'desktop/electron/package-lock.json', 'server.json']) {
    assert.equal(read(file).version, version, `${file} version differs`);
  }
  assert.equal(read('server.json').packages[0].version, version);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries({ ...release, commit }).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(release));
}
