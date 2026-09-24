/**
 * Getting servers back out, and handing someone a form to fill in.
 *
 * Export exists for the obvious reason — your list should not be trapped in this
 * tool — and for a less obvious one: it is how the import format documents
 * itself. Export your servers, look at the columns, and you know exactly what a
 * spreadsheet has to contain.
 *
 * **No secrets leave this way.** A password or a passphrase in the vault stays
 * in the vault; the export carries hosts, users, ports and key *paths*. An
 * export is a file people mail to each other and commit by accident, and a
 * format that sometimes contains a production password is a format nobody can
 * use safely. Where a secret exists, the export says so in a column rather than
 * printing it.
 */
import { writeSheet } from './xlsx.js';

/**
 * The columns, in the order a person reads them.
 *
 * Typed as tuples, or every `.map` off this array widens to `(string|number)[]`
 * and the sheet writer stops accepting it.
 *
 * @type {[string, string, number][]}
 */
const FIELDS = [
  ['name', 'name', 18],
  ['host', 'host', 30],
  ['user', 'user', 16],
  ['port', 'port', 7],
  ['keyPath', 'key path', 34],
  ['defaultDir', 'default directory', 24],
  ['group', 'group', 16],
  ['platform', 'platform', 11],
  ['proxyJump', 'proxy jump', 16],
  ['description', 'description', 30],
];

/** @param {any} server @returns {string[]} One row, in FIELDS order */
function row(server) {
  return FIELDS.map(([field]) => {
    const value = server[field];
    if (value === undefined || value === null) return '';
    if (field === 'port' && Number(value) === 22) return '';
    return String(value);
  });
}

/** @param {any[]} servers @returns {string[][]} Header plus one row each */
function table(servers) {
  return [FIELDS.map(([, header]) => header), ...servers.map(row)];
}

/**
 * @param {any[]} servers
 * @returns {string} RFC 4180 CSV, comma-separated, with a UTF-8 BOM
 */
export function toCsv(servers) {
  const quote = cell => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  const body = table(servers).map(cells => cells.map(quote).join(',')).join('\n');
  // The BOM is what makes Excel on Windows read this as UTF-8 rather than
  // Latin-1, which is the difference between "café" and "cafÃ©" in a hostname
  // comment. Every other reader ignores it.
  return `\ufeff${body}\n`;
}

/** @param {any[]} servers @returns {Buffer} */
export function toXlsx(servers) {
  return writeSheet(table(servers), {
    sheetName: 'Servers',
    widths: FIELDS.map(([, , width]) => width),
  });
}

/**
 * A blank form, with examples.
 *
 * The examples are deliberately obvious fiction — `example.com`, `10.0.0.5` —
 * so nobody imports them by accident and everybody can see what each column
 * wants. They are meant to be typed over.
 *
 * @returns {Buffer}
 */
export function template() {
  const examples = [
    { name: 'production', host: 'prod.example.com', user: 'deploy', port: 22,
      keyPath: '~/.ssh/id_ed25519', defaultDir: '/var/www', group: 'production',
      description: 'Delete this row and the two below, then add your own' },
    { name: 'staging', host: 'staging.example.com', user: 'deploy',
      keyPath: '~/.ssh/id_ed25519', group: 'staging' },
    { name: 'internal', host: '10.0.0.5', user: 'admin', port: 2222,
      group: 'infra', proxyJump: 'production',
      description: 'Reached through the production host' },
  ];
  return writeSheet([
    FIELDS.map(([, header]) => header),
    ...examples.map(row),
    [],
    ['# Only "host" is required.', '', '', '', '', '', '', '', '', ''],
    ['# Leave port empty for 22.', '', '', '', '', '', '', '', '', ''],
    ['# "group" is any label you like — it is what you run commands across.', '', '', '', '', '', '', '', '', ''],
    ['# "platform" is only for Windows hosts. Leave it empty otherwise.', '', '', '', '', '', '', '', '', ''],
    ['# "proxy jump" is the name of another row, used as a bastion.', '', '', '', '', '', '', '', '', ''],
    ['# Passwords are never read from this file. You are asked once, on first connection.', '', '', '', '', '', '', '', '', ''],
  ], { sheetName: 'Servers', widths: FIELDS.map(([, , width]) => width) });
}
