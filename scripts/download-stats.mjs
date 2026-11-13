#!/usr/bin/env node
/**
 * Count how often mcp-ssh-manager has been downloaded, from npm and from the
 * GitHub releases, and write the files the README badges read (shields.io
 * "endpoint" format) plus the raw numbers.
 *
 *   node scripts/download-stats.mjs <output directory>
 *
 * What counts as a download:
 *   - npm: every download the registry reports since the first version;
 *   - GitHub releases: the desktop installers (.dmg, -setup.exe, .AppImage,
 *     .deb), the archives a macOS app downloads to update itself (.zip) and
 *     the package tarballs attached to some releases (.tgz).
 * What does not: the update feeds (latest*.yml), which the application reads
 * every time it checks for an update, the blockmaps, the manifests and the
 * SBOM. They are counted separately in stats.json so the exclusion is visible.
 *
 * Reads GITHUB_TOKEN when set (higher API rate limit); needs no dependency.
 * docs/DOWNLOAD-STATS.md explains the numbers to readers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'mcp-ssh-manager';
const REPOSITORY = 'bvisible/mcp-ssh-manager';
const COLOR = 'c04500';
// The npm downloads API answers at most 18 months per request.
const WINDOW_DAYS = 500;

/**
 * What a release asset is, for counting.
 * @param {string} name
 * @returns {'installer'|'appUpdate'|'tarball'|'updateFeed'|'other'}
 */
export function classifyAsset(name) {
  if (/\.(dmg|AppImage|deb)$/.test(name) || /-setup\.exe$/.test(name)) return 'installer';
  if (/\.zip$/.test(name)) return 'appUpdate';
  if (/\.tgz$/.test(name)) return 'tarball';
  if (/\.ya?ml$/.test(name)) return 'updateFeed';
  return 'other';
}

/**
 * Totals from the npm count and the releases' assets.
 * @param {{npm: number, releases: {assets: {name: string, download_count: number}[]}[]}} input
 */
export function summarize({ npm, releases }) {
  const github = { installer: 0, appUpdate: 0, tarball: 0, updateFeed: 0, other: 0 };
  for (const release of releases) {
    for (const asset of release.assets || []) {
      github[classifyAsset(asset.name)] += asset.download_count || 0;
    }
  }
  const desktop = github.installer + github.appUpdate;
  return {
    npm,
    desktop,
    github,
    total: npm + desktop + github.tarball,
  };
}

/**
 * A count the way shields.io writes it: 423, 1.2k, 46k, 1.3M.
 * @param {number} n
 */
export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 9950) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 999500) return `${Math.round(n / 1000)}k`;
  if (n < 9950000) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1e6)}M`;
}

/**
 * A shields.io endpoint badge.
 * @param {string} label
 * @param {number} count
 */
export function badge(label, count) {
  return { schemaVersion: 1, label, message: compact(count), color: COLOR };
}

/** @param {Date} date */
const day = date => date.toISOString().slice(0, 10);

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 */
async function getJSON(url, headers = {}) {
  const response = await fetch(url, { headers: { 'user-agent': `${PACKAGE}-download-stats`, ...headers } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** Every npm download since the package's first version. */
async function npmDownloads() {
  const meta = await getJSON(`https://registry.npmjs.org/${PACKAGE}`);
  let start = new Date(meta.time.created);
  const today = new Date();
  let total = 0;
  while (start <= today) {
    const end = new Date(Math.min(start.getTime() + (WINDOW_DAYS - 1) * 86400000, today.getTime()));
    const range = await getJSON(`https://api.npmjs.org/downloads/range/${day(start)}:${day(end)}/${PACKAGE}`);
    total += range.downloads.reduce((sum, entry) => sum + entry.downloads, 0);
    start = new Date(end.getTime() + 86400000);
  }
  return total;
}

/** Every release, drafts excluded (the API only lists them to writers). */
async function releases() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await getJSON(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`, headers);
    all.push(...batch.filter(release => !release.draft));
    if (batch.length < 100) return all;
  }
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node scripts/download-stats.mjs <output directory>');
  const summary = summarize({ npm: await npmDownloads(), releases: await releases() });
  fs.mkdirSync(out, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  write('downloads.json', badge('downloads', summary.total));
  write('desktop.json', badge('desktop app downloads', summary.desktop));
  write('stats.json', { updated: new Date().toISOString(), ...summary });
  console.log(`npm ${summary.npm} · desktop ${summary.desktop} · tarballs ${summary.github.tarball} · total ${summary.total}`
    + ` (not counted: ${summary.github.updateFeed} update checks, ${summary.github.other} other files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
