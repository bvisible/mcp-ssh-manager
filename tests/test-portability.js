// Getting servers in and out.
//
// The guarantee worth protecting here is not "the parser works" — it is that an
// import never invents a server and an export never leaks a secret. Both are the
// kind of thing that is fine until one day it silently is not, which is what a
// test is for.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSheet, writeSheet } from '../src/xlsx.js';
import { importFile, plan } from '../src/server-import.js';
import { toCsv, toXlsx, template } from '../src/server-export.js';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'portability-'));
const write = (name, content) => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, content);
  return file;
};

function testSpreadsheetRoundTrip() {
  const rows = [
    ['name', 'host', 'port'],
    ['prod', 'a.example.com', '22'],
    // The characters that break a naive XML writer, and one that breaks a naive
    // reader: an empty cell in the middle, which makes the row sparse.
    ['odd "quoted" & <angled>', '', 'é'],
  ];
  const back = readSheet(writeSheet(rows));
  assert.deepStrictEqual(back, rows, 'a sheet must survive being written and read');
  ok('a spreadsheet survives a round trip, entities and gaps included');
}

function testTemplateImportsAsItself() {
  const file = write('t.xlsx', template());
  const { servers, warnings } = importFile(file);
  assert.deepStrictEqual(servers.map(s => s.name), ['production', 'staging', 'internal']);
  assert.deepStrictEqual(warnings, [],
    'the notes at the bottom of the template must not read as broken servers');
  assert.strictEqual(servers[2].proxyJump, 'production');
  assert.strictEqual(servers[2].port, 2222);
  ok('the template imports as exactly the three examples in it');
}

function testCsv() {
  const file = write('s.csv', [
    'name,host,user,description',
    'web,10.0.0.1,deploy,"a comment, with a comma"',
    'semi;separated;ignored;here',
  ].join('\n'));
  const { servers } = importFile(file);
  assert.strictEqual(servers[0].description, 'a comment, with a comma',
    'quoted commas belong to the cell, not the row');
  ok('CSV respects quoting');

  // A file Excel wrote in a locale that uses semicolons.
  const semi = write('fr.csv', 'name;host;user\nweb;10.0.0.2;deploy\n');
  assert.strictEqual(importFile(semi).servers[0].host, '10.0.0.2');
  ok('a semicolon-separated CSV is read too — Excel writes those in half of Europe');
}

function testSshConfig() {
  const file = write('config', `
Host *
  ServerAliveInterval 60

Host prod production
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host internal
  HostName 10.0.0.5
  ProxyJump jumpuser@prod

Include ~/.ssh/conf.d/*
`);
  const { servers, warnings } = importFile(file);
  assert.deepStrictEqual(servers.map(s => s.name), ['prod', 'internal'],
    'Host * is defaults, not a server, and aliases are one machine');
  assert.strictEqual(servers[0].port, 2222);
  assert.ok(servers[0].keyPath.startsWith(os.homedir()), '~ is expanded');
  assert.strictEqual(servers[1].proxyJump, 'prod', 'the user is stripped from a ProxyJump');
  assert.ok(warnings.some(w => w.includes('Include')),
    'an Include that was not followed has to be said out loud');
  ok('~/.ssh/config: wildcards skipped, aliases collapsed, ProxyJump and Include handled');
}

function testFileZillaKeepsOnlySftp() {
  const file = write('sitemanager.xml', `<?xml version="1.0"?>
<FileZilla3><Servers>
<Server><Host>sftp.example.com</Host><Port>22</Port><Protocol>1</Protocol>
<User>deploy</User><Name>prod</Name></Server>
<Server><Host>ftp.example.com</Host><Port>21</Port><Protocol>0</Protocol>
<User>anon</User><Name>oldftp</Name></Server>
</Servers></FileZilla3>`);
  const { servers, warnings } = importFile(file);
  assert.deepStrictEqual(servers.map(s => s.name), ['prod'],
    'an FTP site is not an SSH server and must not be imported as one');
  assert.ok(warnings.some(w => w.includes('oldftp')), 'and the skip is reported');
  ok('FileZilla: SFTP entries only, FTP reported and skipped');
}

function testPuttyWarnsAboutPpk() {
  const file = write('putty.reg', `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\my%20prod]
"HostName"="prod.example.com"
"PortNumber"=dword:0000089c
"UserName"="deploy"
"PublicKeyFile"="C:\\\\keys\\\\id.ppk"
"Protocol"="ssh"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial]
"Protocol"="serial"
`);
  const { servers, warnings } = importFile(file);
  assert.strictEqual(servers.length, 1, 'a serial session is not an SSH server');
  assert.strictEqual(servers[0].name, 'my_prod', 'the percent-encoded name is decoded');
  assert.strictEqual(servers[0].port, 2204);
  assert.strictEqual(servers[0].keyPath, undefined,
    'a .ppk path would fail at connection time, so it is not stored');
  assert.ok(warnings.some(w => w.includes('puttygen')),
    'and the conversion command is given rather than left to be searched for');
  ok('PuTTY: names decoded, dword ports, .ppk refused with the fix');
}

function testTermiusAndMobaXterm() {
  const termius = write('termius.json', JSON.stringify({
    groups: [{ id: 7, label: 'Production' }],
    hosts: [{ label: 'web', address: 'w.example.com', port: 22, username: 'deploy', group: 7 }],
  }));
  const fromTermius = importFile(termius).servers[0];
  assert.strictEqual(fromTermius.host, 'w.example.com');
  assert.strictEqual(fromTermius.group, 'production', 'the group label follows the host');
  ok('Termius: hosts and their group');

  const moba = write('s.mxtsessions', [
    '[Bookmarks_1]', 'SubRep=Prod',
    'web=#109#0%m.example.com%2222%deploy%%-1%',
    'rdp=#91#4%win.example.com%3389%user%',
  ].join('\n'));
  const { servers, warnings } = importFile(moba);
  assert.deepStrictEqual(servers.map(s => s.name), ['web'], 'an RDP bookmark is not an SSH server');
  assert.strictEqual(servers[0].port, 2222);
  assert.strictEqual(servers[0].group, 'prod');
  assert.ok(warnings.some(w => w.includes('rdp')));
  ok('MobaXterm: SSH bookmarks only, folder becomes the group');
}

function testHostShorthands() {
  const file = write('short.csv', 'name,host\na,deploy@example.com:2222\nb,[2001:db8::1]\n');
  const { servers } = importFile(file);
  assert.strictEqual(servers[0].user, 'deploy', 'user@host in one cell is understood');
  assert.strictEqual(servers[0].host, 'example.com');
  assert.strictEqual(servers[0].port, 2222);
  assert.strictEqual(servers[1].host, '[2001:db8::1]',
    'an IPv6 literal is full of colons and none of them is a port');
  ok('user@host:port is split, and IPv6 is left alone');
}

function testNoSecretEverLeaves() {
  // Everything a server can carry, including the things that must not come out.
  const servers = [{
    name: 'prod', host: 'p.example.com', user: 'deploy', port: 22,
    password: 'hunter2', passphrase: 'open sesame', sudoPassword: 'root-please',
    keyPath: '/home/deploy/.ssh/id_ed25519', group: 'production',
  }];

  const csv = toCsv(servers);
  const sheet = readSheet(toXlsx(servers)).flat().join('\n');
  for (const [format, text] of [['CSV', csv], ['spreadsheet', sheet]]) {
    for (const secret of ['hunter2', 'open sesame', 'root-please']) {
      assert.ok(!text.includes(secret),
        `the ${format} export leaked "${secret}" — an export is a file people email`);
    }
    assert.ok(text.includes('p.example.com'), `the ${format} export must still carry the host`);
    assert.ok(text.includes('id_ed25519'), 'a key *path* is not a secret and is useful');
  }
  ok('no export carries a password, a passphrase or a sudo password');

  assert.strictEqual(csv.charCodeAt(0), 0xfeff,
    'without a BOM, Excel on Windows reads UTF-8 as Latin-1');
  ok('the CSV starts with a BOM, so Excel does not mangle accented text');
}

function testImportIsAdditive() {
  const incoming = [
    { name: 'prod', host: 'a' }, { name: 'new', host: 'b' }, { name: 'prod', host: 'c' },
  ];
  const { fresh, conflicts } = plan(incoming, ['prod', 'other']);
  assert.deepStrictEqual(conflicts.map(s => s.name), ['prod'],
    'a name that already exists is a conflict, never a silent overwrite');
  assert.deepStrictEqual(fresh.map(s => s.name), ['new', 'prod_2'],
    'and two rows with the same name do not collapse into one');
  ok('import is additive: nothing is overwritten and nothing is lost to a name clash');
}

function main() {
  try {
    testSpreadsheetRoundTrip();
    testTemplateImportsAsItself();
    testCsv();
    testSshConfig();
    testFileZillaKeepsOnlySftp();
    testPuttyWarnsAboutPpk();
    testTermiusAndMobaXterm();
    testHostShorthands();
    testNoSecretEverLeaves();
    testImportIsAdditive();
    console.log(`\n✅ portability tests passed (${passed} checks)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main();
