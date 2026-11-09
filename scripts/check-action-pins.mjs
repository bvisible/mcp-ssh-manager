#!/usr/bin/env node
/**
 * Check that every action a workflow pins by SHA is pinned to a commit of that
 * action's own repository.
 *
 * Two ways a pin can look right and be wrong:
 *
 *  - the SHA of an annotated tag object instead of the commit it points to.
 *    GitHub Actions runs it, but OpenSSF Scorecard refuses to publish results
 *    from such a workflow ("imposter commit"), and from 2026-08-28 to 2026-11-09
 *    the Scorecard results of this repository were never published because of
 *    one, with every run green.
 *  - a commit from a fork. GitHub resolves those through the parent repository,
 *    which is how an "imposter commit" smuggles code in under a trusted name.
 *
 * Asks the GitHub API (GITHUB_TOKEN or GH_TOKEN when set) whether
 * repos/<owner>/<repo>/commits/<sha> exists. Exits 1 on any pin that is not one.
 *
 *   node scripts/check-action-pins.mjs [workflow files…]   (default: .github/workflows/*.yml)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(root, '.github', 'workflows')).filter(name => /\.ya?ml$/.test(name))
    .map(name => path.join(root, '.github', 'workflows', name));

const pins = new Map();
for (const file of files) {
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})/g)) {
    const key = `${match[1]}@${match[2]}`;
    if (!pins.has(key)) pins.set(key, []);
    pins.get(key).push(path.relative(root, file));
  }
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'mcp-ssh-manager-pin-check', ...(token ? { authorization: `Bearer ${token}` } : {}) };
let bad = 0;
for (const [key, where] of pins) {
  const [repo, sha] = key.split('@');
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, { headers });
  if (response.ok) {
    console.log(`ok   ${repo}@${sha.slice(0, 12)}`);
    continue;
  }
  bad++;
  const tag = await fetch(`https://api.github.com/repos/${repo}/git/tags/${sha}`, { headers });
  const reason = tag.ok
    ? `the SHA of a tag object; pin the commit it points to, ${(await tag.json()).object.sha}`
    : `not a commit of ${repo} (HTTP ${response.status})`;
  console.log(`FAIL ${repo}@${sha.slice(0, 12)} in ${where.join(', ')}: ${reason}`);
}
console.log(bad ? `\n${bad} pinned action(s) do not point to a commit of their repository` : `\nall ${pins.size} pinned actions point to commits of their repositories`);
process.exit(bad ? 1 : 0);
