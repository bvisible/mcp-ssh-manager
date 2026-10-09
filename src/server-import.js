/**
 * Getting servers in from wherever they already are.
 *
 * ## Why this is a list of readers and not one importer
 *
 * Nobody starts here. They have a `~/.ssh/config` with forty hosts, or a
 * FileZilla site manager, or a spreadsheet a colleague sent them. Asking them to
 * retype it is asking them not to bother, and every one of those sources is a
 * different shape.
 *
 * So each format is a small reader that answers two questions — does this look
 * like mine, and what servers are in it — and everything after that is shared:
 * one normalisation, one validation, one merge. Adding a format is forty lines
 * and cannot break the others.
 *
 * ## What is deliberately not read
 *
 * **Passwords.** FileZilla stores them base64-encoded, PuTTY does not store them
 * at all, Transmit keeps them in the keychain. Importing a credential silently
 * from another application's store is not a favour: it copies a secret the
 * person has forgotten they have, into a second place they now have to think
 * about. Hosts, users, ports and key paths come across; a password is asked for
 * once, by them, when they first connect.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { readSheet } from './xlsx.js';
import { logger } from './logger.js';

/**
 * @typedef {object} ImportedServer
 * @property {string} name
 * @property {string} host
 * @property {string} [user]
 * @property {number} [port]
 * @property {string} [keyPath]
 * @property {string} [defaultDir]
 * @property {string} [description]
 * @property {string} [group]
 * @property {string} [platform]
 * @property {string} [proxyJump]
 */

/** The columns a spreadsheet or CSV may use, and what each becomes. */
const COLUMNS = {
  name: 'name', nom: 'name', label: 'name', alias: 'name', session: 'name',
  host: 'host', hostname: 'host', address: 'host', adresse: 'host', ip: 'host', server: 'host',
  user: 'user', username: 'user', utilisateur: 'user', login: 'user',
  port: 'port',
  key: 'keyPath', keypath: 'keyPath', identityfile: 'keyPath', 'key path': 'keyPath', cle: 'keyPath',
  dir: 'defaultDir', directory: 'defaultDir', defaultdir: 'defaultDir',
  'default dir': 'defaultDir', 'default directory': 'defaultDir', dossier: 'defaultDir',
  description: 'description', comment: 'description', notes: 'description',
  group: 'group', groupe: 'group', category: 'group', tag: 'group', folder: 'group',
  platform: 'platform', os: 'platform',
  proxyjump: 'proxyJump', 'proxy jump': 'proxyJump', bastion: 'proxyJump', jump: 'proxyJump',
};

/** A server name the rest of the system will accept: lowercase, letters, digits, underscore. */
function slug(raw, fallback = 'server') {
  const cleaned = String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/**
 * One row from any source, checked and tidied.
 *
 * @param {Record<string, any>} raw
 * @param {string[]} warnings - Appended to, so the caller can report what was dropped
 * @returns {ImportedServer|null} null when there is nothing usable
 */
function normalise(raw, warnings) {
  // A leading # means a comment, as it does in every other config format. The
  // template uses it for the notes at the bottom; without this they read as
  // three servers that forgot their hostname.
  const label = String(raw.name || '').trim();
  if (label.startsWith('#')) return null;

  const host = String(raw.host || '').trim();
  if (!host) {
    if (label) warnings.push(`"${label}" has no host — skipped`);
    return null;
  }
  // A `user@host` in the host column is a common way to write it.
  let user = raw.user ? String(raw.user).trim() : undefined;
  let bare = host;
  const at = host.lastIndexOf('@');
  if (at > 0) { bare = host.slice(at + 1); user = user || host.slice(0, at); }

  // And so is `host:port`, as long as it is not an IPv6 literal.
  let port = raw.port ? parseInt(String(raw.port), 10) : undefined;
  const colon = bare.lastIndexOf(':');
  if (colon > 0 && !bare.includes('[') && bare.indexOf(':') === colon) {
    const maybe = parseInt(bare.slice(colon + 1), 10);
    if (Number.isInteger(maybe) && maybe > 0 && maybe < 65536) {
      port = port || maybe;
      bare = bare.slice(0, colon);
    }
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    warnings.push(`"${raw.name || bare}" has port "${raw.port}" — ignored, using 22`);
    port = undefined;
  }

  /** @type {ImportedServer} */
  const server = { name: slug(raw.name || bare), host: bare };
  if (user) server.user = user;
  if (port && port !== 22) server.port = port;
  for (const field of ['keyPath', 'defaultDir', 'description', 'group', 'proxyJump']) {
    const value = raw[field] ? String(raw[field]).trim() : '';
    if (value) server[field] = value;
  }
  if (server.keyPath) server.keyPath = server.keyPath.replace(/^~(?=\/)/, os.homedir());
  const platform = String(raw.platform || '').trim().toLowerCase();
  if (platform === 'windows') server.platform = 'windows';
  if (server.group) server.group = server.group.trim().toLowerCase();
  return server;
}

/** Rows of cells (from CSV or a spreadsheet) into servers, using the header row. */
function fromTable(rows, warnings) {
  const header = (rows[0] || []).map(cell => String(cell).trim().toLowerCase());
  const mapping = header.map(cell => COLUMNS[cell] ?? null);
  if (!mapping.includes('host')) {
    throw new Error(
      `No "host" column. Found: ${header.filter(Boolean).join(', ') || '(nothing)'}. `
      + 'The template from `ssh-manager import --template` has the columns this expects.');
  }
  const unknown = header.filter((cell, i) => cell && mapping[i] === null);
  if (unknown.length) warnings.push(`Columns ignored: ${unknown.join(', ')}`);

  return rows.slice(1)
    .filter(row => row.some(cell => String(cell).trim()))
    .map(row => {
      /** @type {Record<string, any>} */
      const raw = {};
      mapping.forEach((field, i) => { if (field) raw[field] = row[i]; });
      return normalise(raw, warnings);
    })
    .filter(Boolean);
}

/** A CSV line splitter that understands quotes, because hosts have commas in comments. */
function splitCsv(text) {
  const separator = (text.split('\n')[0].match(/;/g) || []).length
    > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ------------------------------------------------------------------ readers */

/** @type {{id: string, label: string, detect: (name: string, text: string) => boolean, parse: (text: string, file: string, warnings: string[]) => ImportedServer[]}[]} */
export const READERS = [
  {
    id: 'ssh-config',
    label: 'OpenSSH config (~/.ssh/config)',
    detect: (name, text) => /(^|\/)config$/.test(name) || /^\s*Host\s+\S/mi.test(text),
    parse(text, file, warnings) {
      /** @type {ImportedServer[]} */
      const servers = [];
      /** @type {Record<string, any>|null} */
      let current = null;
      const flush = () => {
        if (!current) return;
        const server = normalise(current, warnings);
        if (server) servers.push(server);
        current = null;
      };
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [keyword, ...rest] = trimmed.split(/[\s=]+/);
        const value = rest.join(' ').trim();
        switch (keyword.toLowerCase()) {
        case 'host': {
          flush();
          // `Host a b c` defines aliases for one machine, and `Host *` is
          // defaults for everything — neither is a server to import.
          const names = value.split(/\s+/).filter(n => !n.includes('*') && !n.includes('?'));
          if (names.length) current = { name: names[0], host: names[0] };
          break;
        }
        case 'include':
          warnings.push(`\`Include ${value}\` was not followed — import those files separately`);
          break;
        case 'hostname': if (current) current.host = value; break;
        case 'user': if (current) current.user = value; break;
        case 'port': if (current) current.port = value; break;
        case 'identityfile': if (current && !current.keyPath) current.keyPath = value; break;
        case 'proxyjump': if (current) current.proxyJump = value.split(',')[0].replace(/^.*@/, ''); break;
        default: break;
        }
      }
      flush();
      return servers;
    },
  },
  {
    id: 'xlsx',
    label: 'Spreadsheet (.xlsx)',
    detect: name => name.toLowerCase().endsWith('.xlsx'),
    parse: (_text, file, warnings) => fromTable(readSheet(fs.readFileSync(file)), warnings),
  },
  {
    id: 'filezilla',
    label: 'FileZilla (sitemanager.xml)',
    detect: (name, text) => /sitemanager\.xml$/i.test(name) || text.includes('<FileZilla3'),
    parse(text, file, warnings) {
      const value = (block, tag) =>
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)?.[1]?.trim() || '';
      /** @type {ImportedServer[]} */
      const servers = [];
      for (const match of text.matchAll(/<Server[\s>]([\s\S]*?)<\/Server>/g)) {
        const block = match[1];
        // FileZilla protocol 1 is SFTP. FTP entries are not SSH servers and
        // importing them would produce hosts that can never connect.
        if (value(block, 'Protocol') !== '1') {
          const skipped = value(block, 'Name') || value(block, 'Host');
          warnings.push(`"${skipped}" is not SFTP — skipped`);
          continue;
        }
        const server = normalise({
          name: value(block, 'Name') || value(block, 'Host'),
          host: value(block, 'Host'),
          user: value(block, 'User'),
          port: value(block, 'Port'),
          keyPath: value(block, 'Keyfile'),
          defaultDir: value(block, 'RemoteDir').replace(/^\d+\s+\d+\s+/, '') || '',
          description: value(block, 'Comments'),
        }, warnings);
        if (server) servers.push(server);
      }
      return servers;
    },
  },
  {
    id: 'putty',
    label: 'PuTTY (exported .reg)',
    detect: (name, text) => text.includes('SimonTatham\\PuTTY\\Sessions'),
    parse(text, file, warnings) {
      /** @type {ImportedServer[]} */
      const servers = [];
      for (const section of text.split(/^\[/m).slice(1)) {
        const header = section.split(']')[0];
        if (!header.includes('PuTTY\\Sessions\\')) continue;
        const raw = header.split('Sessions\\').pop();
        // Session names are percent-encoded in the registry path.
        const name = decodeURIComponent(raw.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
        const str = key => new RegExp(`"${key}"="([^"]*)"`).exec(section)?.[1];
        const dword = key => {
          const hex = new RegExp(`"${key}"=dword:([0-9a-fA-F]+)`).exec(section)?.[1];
          return hex ? parseInt(hex, 16) : undefined;
        };
        if ((str('Protocol') || 'ssh').toLowerCase() !== 'ssh') {
          warnings.push(`"${name}" is not an SSH session — skipped`);
          continue;
        }
        const server = normalise({
          name,
          host: str('HostName'),
          user: str('UserName'),
          port: dword('PortNumber'),
          // A .ppk is PuTTY's own key format; ssh2 cannot read it. Say so
          // rather than storing a path that will fail at connection time.
          keyPath: /\.ppk$/i.test(str('PublicKeyFile') || '') ? '' : str('PublicKeyFile'),
        }, warnings);
        if (server) {
          if (/\.ppk$/i.test(str('PublicKeyFile') || '')) {
            warnings.push(`"${name}" uses a .ppk key — convert it with \`puttygen key.ppk -O private-openssh -o key\``);
          }
          servers.push(server);
        }
      }
      return servers;
    },
  },
  {
    id: 'termius',
    label: 'Termius (JSON export)',
    detect: (name, text) => /^\s*[[{]/.test(text) && /"(address|hosts)"/.test(text),
    parse(text, file, warnings) {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.hosts || data.servers || [];
      /** @type {Map<string, string>} */
      const groups = new Map();
      for (const group of data.groups || []) groups.set(String(group.id), group.label || group.name);
      return list.map(entry => normalise({
        name: entry.label || entry.name || entry.address,
        host: entry.address || entry.host || entry.hostname,
        user: entry.username || entry.user || entry.ssh?.username,
        port: entry.port || entry.ssh?.port,
        group: groups.get(String(entry.group ?? entry.group_id)) || entry.group_label,
        description: entry.description || entry.tags?.join(', '),
      }, warnings)).filter(Boolean);
    },
  },
  {
    id: 'mobaxterm',
    label: 'MobaXterm (.mxtsessions)',
    detect: name => name.toLowerCase().endsWith('.mxtsessions'),
    parse(text, file, warnings) {
      /** @type {ImportedServer[]} */
      const servers = [];
      // The folder a bookmark lives in is `SubRep=`, not the section header —
      // the header is `[Bookmarks_1]`, an index, which is not a name anyone
      // chose or would recognise as their group.
      let folder = '';
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('[')) { folder = ''; continue; }
        const at = trimmed.indexOf('=');
        if (at < 0) continue;
        const name = trimmed.slice(0, at);
        const body = trimmed.slice(at + 1);
        if (name === 'SubRep') { folder = body.split('\\').pop(); continue; }
        if (name === 'ImgNum') continue;
        // `#<type>#<n>%host%port%user%…`; type 109 is SSH.
        const typed = /^#(\d+)#\d+%(.*)$/.exec(body);
        if (!typed) continue;
        if (typed[1] !== '109') { warnings.push(`"${name}" is not an SSH session — skipped`); continue; }
        const parts = typed[2].split('%');
        const server = normalise({
          name, host: parts[0], port: parts[1], user: parts[2],
          group: folder,
        }, warnings);
        if (server) servers.push(server);
      }
      return servers;
    },
  },
  {
    id: 'csv',
    label: 'CSV',
    // Deliberately last, and deliberately grudging. This is the only reader
    // that guesses from content alone, and it used to claim a Termius export:
    // the JSON's first line contains "address" and commas, which was enough.
    detect: (name, text) => name.toLowerCase().endsWith('.csv')
      || (!/^\s*[[{<]/.test(text)
          && /^[^\n]*\b(host|hostname|address)\b[^\n]*[,;]/i.test(text)),
    parse: (text, file, warnings) => fromTable(splitCsv(text), warnings),
  },
];

/* ------------------------------------------------------------- entry points */

/** Where each application keeps its list, when it keeps one somewhere findable. */
export const WELL_KNOWN = {
  'ssh-config': () => [path.join(os.homedir(), '.ssh', 'config')],
  filezilla: () => [
    path.join(os.homedir(), '.config', 'filezilla', 'sitemanager.xml'),
    path.join(os.homedir(), 'Library', 'Application Support', 'FileZilla', 'sitemanager.xml'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'FileZilla', 'sitemanager.xml'),
  ],
};

/**
 * Transmit keeps one binary plist per favourite, so it is a directory rather
 * than a file and cannot be a normal reader.
 *
 * Read through `plutil`, which is on every Mac and is the only supported way to
 * decode a binary plist. Transmit is macOS-only, so there is no other platform
 * to care about.
 *
 * @param {string[]} warnings
 * @returns {ImportedServer[]}
 */
export function readTransmit(warnings) {
  const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Transmit', 'Metadata');
  if (process.platform !== 'darwin' || !fs.existsSync(dir)) return [];
  /** @type {ImportedServer[]} */
  const servers = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.favoriteMetadata'))) {
    try {
      const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(dir, file)],
        { encoding: 'utf8', timeout: 5000 });
      const entry = JSON.parse(json);
      const protocol = String(entry.com_panic_transmit_protocol || '').toUpperCase();
      // Transmit does FTP and WebDAV too; only SFTP is an SSH server.
      if (protocol && !protocol.includes('SFTP')) {
        warnings.push(`"${entry.com_panic_transmit_nickname || file}" is ${protocol} — skipped`);
        continue;
      }
      const server = normalise({
        name: entry.com_panic_transmit_nickname,
        host: entry.com_panic_transmit_server,
        user: entry.com_panic_transmit_username,
        port: entry.com_panic_transmit_port,
      }, warnings);
      if (server) servers.push(server);
    } catch (error) {
      warnings.push(`Could not read ${file}: ${error.message}`);
    }
  }
  return servers;
}

/**
 * Read a file, whatever it turns out to be.
 *
 * @param {string} file - Path to the export
 * @param {string} [forceId] - Skip detection and use this reader
 * @returns {{servers: ImportedServer[], source: string, warnings: string[]}}
 */
export function importFile(file, forceId) {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  const name = path.basename(file);
  // A spreadsheet is a zip; reading it as text would be nonsense, so only read
  // enough to sniff with and let the reader open the file itself if it needs to.
  const isBinary = /\.xlsx$/i.test(name);
  const text = isBinary ? '' : fs.readFileSync(file, 'utf8');

  const reader = forceId
    ? READERS.find(r => r.id === forceId)
    : READERS.find(r => r.detect(name, text));
  if (!reader) {
    throw new Error(
      `Cannot tell what ${name} is. Name the format with --format <id>, one of: `
      + READERS.map(r => r.id).join(', '));
  }

  /** @type {string[]} */
  const warnings = [];
  const servers = reader.parse(text, file, warnings);
  logger.info('Servers read for import', { source: reader.id, count: servers.length });
  return { servers, source: reader.label, warnings };
}

/**
 * Merge imported servers over what is already configured.
 *
 * Existing entries are never silently overwritten: a name that already exists
 * comes back as a conflict for the caller to decide about. Import is additive
 * or it is a footgun.
 *
 * @param {ImportedServer[]} incoming
 * @param {string[]} existing - Names already configured
 * @returns {{fresh: ImportedServer[], conflicts: ImportedServer[]}}
 */
export function plan(incoming, existing) {
  const known = new Set(existing.map(name => name.toLowerCase()));
  const seen = new Set();
  /** @type {ImportedServer[]} */
  const fresh = [];
  /** @type {ImportedServer[]} */
  const conflicts = [];
  for (const server of incoming) {
    // Two rows can slug to the same name; the second gets a suffix rather than
    // silently replacing the first.
    let name = server.name;
    for (let n = 2; seen.has(name); n++) name = `${server.name}_${n}`;
    seen.add(name);
    const resolved = { ...server, name };
    (known.has(name) ? conflicts : fresh).push(resolved);
  }
  return { fresh, conflicts };
}
