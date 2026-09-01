/**
 * Give node-pty's spawn helper back its executable bit.
 *
 * The npm tarball ships `prebuilds/<platform>/spawn-helper` as 644. node-pty
 * runs it for every pseudo-terminal it opens, so without the bit the first
 * local shell dies on `posix_spawnp failed` — and only in a packaged build,
 * because a developer's checkout usually has a chmod'd copy from somewhere.
 *
 * Before signing rather than after: this is a nested Mach-O executable, and it
 * has to be signed as one for the notarized app to pass Gatekeeper.
 */
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const unpacked = context.appOutDir;
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a directory we cannot read has nothing we need
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'spawn-helper') found.push(full);
    }
  };
  walk(unpacked);

  for (const file of found) {
    fs.chmodSync(file, 0o755);
    console.log(`  • made executable  ${path.relative(unpacked, file)}`);
  }
  if (found.length === 0) console.log('  • no spawn-helper found — no local shell in this build');
};
