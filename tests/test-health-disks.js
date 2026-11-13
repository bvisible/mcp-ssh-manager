import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildComprehensiveHealthCheckCommand, parseComprehensiveHealthCheck, checkAlertThresholds } from '../src/health-monitor.js';

const records = [
  { filesystem: 'ext4', mount: '/', size: '29G', used: '25G', avail: '4.4G', percent: 85 },
  { filesystem: 'overlay', mount: '/var/lib/docker/rootfs/overlayfs/abcdef', percent: 85 },
  { filesystem: 'tmpfs', mount: '/run', percent: 1 },
  { filesystem: 'devtmpfs', mount: '/dev', percent: 0 },
  { filesystem: 'squashfs', mount: '/snap/core/123', percent: 100 },
  { filesystem: 'vfat', mount: '/boot/efi', percent: 6 },
  { filesystem: 'xfs', mount: '/srv/customer-data', percent: 87 },
  { filesystem: 'nfs4', mount: '/mnt/backup', percent: 92 },
];
const newline = String.fromCharCode(10);
const parse = disks => parseComprehensiveHealthCheck('=== DISK ===' + newline + disks.map(d => JSON.stringify(d)).join(newline)).disks;
const disks = parse(records);
assert.deepEqual(disks.map(d => d.mount), ['/', '/boot/efi', '/srv/customer-data', '/mnt/backup']);
assert.equal(parse([{ filesystem: 'overlay', mount: '/', percent: 85 }]).length, 1, 'containerized hosts retain their root disk');
assert.equal(parse([{ mount: '/', percent: 85 }]).length, 1, 'older metric payloads remain readable');
const alerts = checkAlertThresholds({ disks }, { disk: 85 });
assert.deepEqual(alerts.map(a => a.mount), ['/', '/srv/customer-data', '/mnt/backup'], 'each real disk alerts once, including at the threshold');

// Exercise the generated Linux df formatter with deterministic output; awk is
// unavailable on a bare Windows runner, where parser checks above still run.
if (process.platform !== 'win32') {
  const command = buildComprehensiveHealthCheckCommand().split(newline).find(line => line.includes('df -PTh'));
  const formatter = command.slice(command.indexOf('awk '));
  const output = execFileSync('sh', ['-c', formatter], {
    input: ['Filesystem Type Size Used Avail Use% Mounted on', '/dev/vda1 ext4 29G 25G 4.4G 85% /', 'overlay overlay 29G 25G 4.4G 85% /var/lib/docker/rootfs/test', ''].join(newline),
    encoding: 'utf8',
  });
  const rows = output.trim().split(newline).map(line => JSON.parse(line));
  assert.equal(rows[0].filesystem, 'ext4');
  assert.equal(rows[0].mount, '/');
  assert.equal(rows[0].percent, 85);
  assert.equal(rows[1].filesystem, 'overlay');
  assert.equal(parse(rows).length, 1);
}
console.log('Persistent disk filtering, Linux collection and threshold checks passed.');
