#!/usr/bin/env node
// `ssh-manager vault` — manage the encrypted credential store.
//
// This is the headless half of what a GUI will later do with buttons. Both
// drive the same SecretStore, so anything possible in the interface is possible
// here, and a server added by either is visible to the other immediately.
//
// Commands:
//   list                     Show what the vault holds (never prints secrets)
//   add <name>               Add or replace a server (prompts for the password)
//   remove <name>            Delete a server
//   import [--from <path>]   Copy servers from a .env into the vault
//   status                   Where the vault and its key live

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { writeRecoveryFile, readRecoveryFile, describeRecoveryFile } from '../src/vault-recovery.js';
import { SecretStore, defaultVaultPath, resolveMasterKey, SECRET_FIELDS } from '../src/secret-store.js';
import { defaultSocketPath, isControlPlaneListening, VALID_APPROVAL_MODES } from '../src/approval.js';
import { ConfigLoader } from '../src/config-loader.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Ask a question on the terminal.
 * @param {string} question - Prompt text
 * @param {boolean} [hidden] - Mask the input (for secrets)
 * @returns {Promise<string>} The answer, trimmed
 */
let sharedReadline = null;

/**
 * The one readline interface for the whole command.
 *
 * Created per question originally, which works at a keyboard and fails
 * everywhere else: an interface opened on a pipe reads whatever is buffered and
 * discards the rest when it closes, so the second question of a pair never sees
 * its answer. One interface, closed at the end, behaves the same either way.
 */
function getReadline() {
  if (!sharedReadline) {
    sharedReadline = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
  }
  return sharedReadline;
}

/** Release stdin so the process can exit. */
function closeReadline() {
  sharedReadline?.close();
  sharedReadline = null;
}

function ask(question, hidden = false) {
  const rl = getReadline();
  return new Promise(resolve => {
    if (hidden) {
      // Suppress echo: a password typed into a terminal should not stay
      // visible in the scrollback of a shared screen or a recorded session.
      const onData = () => { rl.output.write('\x1B[2K\x1B[200D' + question); };
      rl.input.on('data', onData);
      rl.question(question, answer => {
        rl.input.removeListener('data', onData);
        rl.output.write('\n');
        resolve(answer.trim());
      });
      return;
    }
    rl.question(question, answer => resolve(answer.trim()));
  });
}

function usage() {
  console.log(`
${GREEN}ssh-manager vault${RESET} — encrypted credential store

  ${GREEN}list${RESET}                      Servers held in the vault
  ${GREEN}add${RESET} <name>                Add or replace a server
  ${GREEN}remove${RESET} <name>             Delete a server
  ${GREEN}import${RESET} [--from <path>]    Copy servers from a .env into the vault
  ${GREEN}backup${RESET} <file>             Write a recovery file, encrypted with a passphrase
  ${GREEN}restore${RESET} <file>            Read one back into the vault
  ${GREEN}status${RESET}                    Where the vault and its key live

${DIM}Secrets are encrypted with AES-256-GCM. The key lives in your OS keychain
when there is one, otherwise in a 0600 file next to the vault.
Set SSH_MANAGER_KEY_SOURCE=file to skip the keychain (CI, containers).

That key belongs to this machine. Before you delete secrets from a .env,
take a recovery file — it is the copy that survives a new laptop.${RESET}
`);
}

/**
 * Write a recovery file. Asked for twice, because a passphrase typed once and
 * mistyped is a file nobody can open, discovered at the worst moment.
 *
 * @param {import('../src/secret-store.js').SecretStore} store - The vault
 * @param {string} target - Where to write
 */
async function cmdBackup(store, target) {
  if (!target) {
    console.error(`${YELLOW}Where should it go?${RESET}  ssh-manager vault backup ~/ssh-manager-recovery.json`);
    process.exit(1);
  }
  const servers = store.getAllDecrypted();
  const count = Object.keys(servers).length;
  if (count === 0) {
    console.error(`${YELLOW}The vault is empty — nothing to back up.${RESET}`);
    process.exit(1);
  }

  console.log(`
${GREEN}${count} server(s) will be written to ${target}${RESET}

${DIM}The file is encrypted with a passphrase you choose here — not with this
machine's key. That is the point: it is what still opens on a new laptop.
Keep it where you keep passwords, not next to the vault.${RESET}
`);

  const passphrase = await ask('Passphrase (at least 8 characters): ', true);
  if (passphrase.length < 8) {
    console.error(`${YELLOW}Too short. Nothing written.${RESET}`);
    process.exit(1);
  }
  const again = await ask('Again: ', true);
  if (again !== passphrase) {
    console.error(`${YELLOW}They do not match. Nothing written.${RESET}`);
    process.exit(1);
  }

  const result = writeRecoveryFile(servers, passphrase, target);
  console.log(`
${GREEN}✓${RESET} ${result.servers} server(s), ${result.secrets} secret(s) → ${result.path}
${DIM}Read it back with: ssh-manager vault restore ${target}
There is no way to recover the passphrase. If you lose it, this file is noise.${RESET}
`);
}

/**
 * Read a recovery file back into the vault.
 *
 * @param {import('../src/secret-store.js').SecretStore} store - The vault
 * @param {string} source - The file
 */
async function cmdRestore(store, source) {
  if (!source) {
    console.error(`${YELLOW}Which file?${RESET}  ssh-manager vault restore ~/ssh-manager-recovery.json`);
    process.exit(1);
  }

  let described;
  try {
    described = describeRecoveryFile(source);
  } catch (error) {
    console.error(`${YELLOW}${error.message}${RESET}`);
    process.exit(1);
  }

  console.log(`
${GREEN}${source}${RESET}
${DIM}written ${new Date(described.createdAt).toLocaleString()} · ${described.servers} server(s), ${described.secrets} secret(s)${RESET}
`);

  const passphrase = await ask('Passphrase: ', true);
  let servers;
  try {
    servers = readRecoveryFile(source, passphrase);
  } catch (error) {
    console.error(`${YELLOW}${error.message}${RESET}`);
    process.exit(1);
  }

  const existing = store.exists() ? store.listServers() : [];
  const clashes = Object.keys(servers).filter(name => existing.includes(name));
  if (clashes.length > 0) {
    console.log(`${YELLOW}Already in the vault and about to be replaced:${RESET} ${clashes.join(', ')}`);
    const answer = await ask('Continue? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  for (const [name, config] of Object.entries(servers)) store.setServer(name, config);
  console.log(`\n${GREEN}✓${RESET} ${Object.keys(servers).length} server(s) restored into ${store.vaultPath}\n`);
}

/**
 * Warn when the vault cannot actually be opened. Printed before the listing
 * rather than after: an operator who reads "3 servers" and stops reading has
 * been told the opposite of the truth.
 *
 * @param {import('../src/secret-store.js').SecretStore} store - The vault
 * @returns {boolean} True when everything decrypts
 */
function warnIfUnreadable(store) {
  const check = store.checkKey();
  if (check.ok) return true;
  console.error(`
${RED}This vault cannot be read on this machine.${RESET}

${check.reason}
`);
  return false;
}

async function cmdList(store) {
  const names = store.listServers();
  if (names.length === 0) {
    console.log(`${YELLOW}The vault is empty.${RESET} Add a server with: ssh-manager vault add <name>`);
    console.log(`${DIM}Or copy what you already have: ssh-manager vault import${RESET}`);
    return;
  }
  const readable = warnIfUnreadable(store);
  const raw = store.read();
  console.log(`\n${readable ? GREEN : YELLOW}${names.length} server(s) in the vault${RESET}  ${DIM}${store.vaultPath}${RESET}\n`);
  for (const name of names) {
    const s = raw.servers[name];
    const secrets = SECRET_FIELDS.filter(f => s[f]).map(f => f.replace('Password', ' password'));
    const auth = s.keyPath ? `key ${s.keyPath}` : (secrets.length ? 'password' : `${YELLOW}no credential${RESET}`);
    const mode = s.mode && s.mode !== 'unrestricted' ? `  ${YELLOW}[${s.mode}]${RESET}` : '';
    console.log(`  ${name.padEnd(16)} ${String(s.user || '?')}@${String(s.host || '?')}:${s.port || 22}  ${DIM}${auth}${RESET}${mode}`);
    if (secrets.length) console.log(`  ${' '.repeat(16)} ${DIM}encrypted: ${secrets.join(', ')}${RESET}`);
  }
  console.log();
}

async function cmdAdd(store, name) {
  if (!name) { console.error(`${RED}Usage: ssh-manager vault add <name>${RESET}`); process.exit(1); }

  const existing = store.read().servers[name.toLowerCase()];
  if (existing) console.log(`${YELLOW}"${name}" already exists — this will replace it.${RESET}\n`);

  const host = await ask(`Host${existing?.host ? ` [${existing.host}]` : ''}: `) || existing?.host;
  if (!host) { console.error(`${RED}A host is required.${RESET}`); process.exit(1); }
  const user = await ask(`User${existing?.user ? ` [${existing.user}]` : ''}: `) || existing?.user;
  const port = await ask('Port [22]: ') || '22';
  const keyPath = await ask('SSH key path (blank to use a password): ');

  /** @type {Record<string, any>} */
  const config = { host, user, port: Number(port) };
  if (keyPath) {
    config.keyPath = keyPath;
    const passphrase = await ask('Key passphrase (blank if none): ', true);
    if (passphrase) config.passphrase = passphrase;
  } else {
    const password = await ask('Password: ', true);
    if (password) config.password = password;
  }

  const sudo = await ask('Sudo password (blank if none): ', true);
  if (sudo) config.sudoPassword = sudo;

  const mode = await ask('Security mode — unrestricted / readonly / restricted [unrestricted]: ');
  if (mode && mode !== 'unrestricted') config.mode = mode;

  store.setServer(name, config);
  console.log(`\n${GREEN}✓${RESET} "${name.toLowerCase()}" saved, secrets encrypted.`);
}

async function cmdRemove(store, name) {
  if (!name) { console.error(`${RED}Usage: ssh-manager vault remove <name>${RESET}`); process.exit(1); }
  if (store.removeServer(name)) {
    console.log(`${GREEN}✓${RESET} "${name.toLowerCase()}" removed from the vault.`);
  } else {
    console.log(`${YELLOW}"${name}" is not in the vault.${RESET}`);
    process.exit(1);
  }
}

async function cmdImport(store, fromPath) {
  const envPath = fromPath || path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error(`${RED}No .env found at ${envPath}${RESET}`);
    console.error(`${DIM}Point at one with: ssh-manager vault import --from /path/to/.env${RESET}`);
    process.exit(1);
  }

  // Load through the real ConfigLoader rather than parsing here, so an imported
  // server is byte-for-byte what the MCP server would have used.
  const loader = new ConfigLoader();
  const servers = await loader.load({ envPath, tomlPath: '/nonexistent', vaultPath: '/nonexistent' });

  if (servers.size === 0) {
    console.log(`${YELLOW}No servers found in ${envPath}.${RESET}`);
    return;
  }

  console.log(`\n${GREEN}${servers.size} server(s) found in ${envPath}${RESET}\n`);
  for (const [name, config] of servers) {
    const secrets = SECRET_FIELDS.filter(f => config[f]);
    console.log(`  ${name.padEnd(16)} ${config.user || '?'}@${config.host}  ${DIM}${secrets.length ? `${secrets.length} secret(s) to encrypt` : 'no secret'}${RESET}`);
  }

  const answer = await ask('\nImport these into the vault? The .env is left untouched. [y/N] ');
  if (answer.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  for (const [name, config] of servers) {
    // `name` is injected by the loader for its own bookkeeping; it is the key.
    const { name: _ignored, ...rest } = config;
    store.setServer(name, rest);
  }

  console.log(`\n${GREEN}✓${RESET} ${servers.size} server(s) imported and encrypted.`);
  console.log(`${DIM}The vault now takes precedence over ${envPath}, which is untouched.${RESET}`);

  // Ordered deliberately. Suggesting the .env can be cleaned up is only safe
  // advice once a copy exists that does not depend on this machine's keychain —
  // otherwise the two sentences together are "delete your only copy".
  console.log(`
${YELLOW}Before you remove anything from ${envPath}:${RESET}

  1. ${GREEN}ssh-manager vault backup ~/ssh-manager-recovery.json${RESET}
     ${DIM}A copy encrypted with a passphrase you choose. The vault's own key
     lives in this machine's keychain and does not travel — a new laptop, a
     reinstalled OS, or a wiped keyring leaves the vault unreadable.${RESET}

  2. ${GREEN}ssh-manager vault status${RESET}
     ${DIM}Confirms this machine can actually decrypt what it just wrote.${RESET}

  3. Run something real against a server.

${DIM}The .env keeps working either way — the vault sits above it, it does not
replace it. Nothing obliges you to delete anything.${RESET}
`);
}

/**
 * One line saying whether this machine can open the vault.
 * @param {{ok: boolean, reason?: string, checked: number}} check - From checkKey()
 * @returns {string}
 */
function describeReadability(check) {
  if (!check.ok) return `${RED}NO — ${check.reason?.split('\n')[0]}${RESET}`;
  if (check.checked === 0) return `${DIM}nothing encrypted yet${RESET}`;
  return `${GREEN}yes${RESET} ${DIM}(${check.checked} secret(s) decrypt with this machine's key)${RESET}`;
}

function cmdStatus(store) {
  const { source } = resolveMasterKey();
  const exists = store.exists();
  // Asked here because "status" is exactly the question this answers, and
  // because the answer used to be reassuring regardless of the truth.
  const check = store.checkKey();
  const socketPath = defaultSocketPath();
  const listening = isControlPlaneListening(socketPath);
  console.log(`
${GREEN}Vault${RESET}      ${store.vaultPath} ${exists ? `${DIM}(${store.listServers().length} server(s))${RESET}` : `${YELLOW}— not created yet${RESET}`}
${GREEN}Key${RESET}        ${source === 'keychain' ? `OS keychain ${DIM}(service: mcp-ssh-manager)${RESET}` : `${YELLOW}file${RESET} ${DIM}${path.join(path.dirname(store.vaultPath), 'vault.key')}${RESET}`}
${GREEN}Cipher${RESET}     AES-256-GCM ${DIM}(authenticated: tampering is detected, not silently accepted)${RESET}
${GREEN}Encrypted${RESET}  ${SECRET_FIELDS.join(', ')}
${GREEN}Readable${RESET}   ${describeReadability(check)}
${GREEN}Recovery${RESET}   ${DIM}ssh-manager vault backup <file> — the copy that survives a new machine${RESET}

${GREEN}Approval${RESET}   ${listening ? `${GREEN}a control plane is listening${RESET}` : `${DIM}nothing listening — actions run without asking${RESET}`}
${GREEN}Socket${RESET}     ${socketPath}
${GREEN}Modes${RESET}      ${[...VALID_APPROVAL_MODES].join(' / ')} ${DIM}(per server: SSH_SERVER_<NAME>_APPROVAL, default never)${RESET}
`);
  if (source === 'file') {
    console.log(`${YELLOW}Note:${RESET} no OS keychain was reachable, so the key sits next to the vault.`);
    console.log(`${DIM}Still better than a clear-text .env, but the keychain is preferable on a desktop.${RESET}\n`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const store = new SecretStore(defaultVaultPath());

  switch (command) {
  case 'list': await cmdList(store); break;
  case 'add': await cmdAdd(store, args[0]); break;
  case 'remove': case 'rm': await cmdRemove(store, args[0]); break;
  case 'import': {
    const i = args.indexOf('--from');
    await cmdImport(store, i >= 0 ? args[i + 1] : null);
    break;
  }
  case 'backup': await cmdBackup(store, args[0]); break;
  case 'restore': await cmdRestore(store, args[0]); break;
  case 'status': cmdStatus(store); break;
  default: usage(); process.exit(command ? 1 : 0);
  }
}

main()
  .then(closeReadline)
  .catch(error => {
    closeReadline();
    // A vault whose key is gone throws a multi-line explanation of what to do
    // about it; printing only `error.message` would still show all of it, but
    // the exit code is what a script reads.
    console.error(`${RED}${error.message}${RESET}`);
    process.exit(1);
  });
