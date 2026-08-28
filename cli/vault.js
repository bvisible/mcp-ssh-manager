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
function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(resolve => {
    if (hidden) {
      // Suppress echo: a password typed into a terminal should not stay
      // visible in the scrollback of a shared screen or a recorded session.
      const onData = () => { rl.output.write('\x1B[2K\x1B[200D' + question); };
      rl.input.on('data', onData);
      rl.question(question, answer => {
        rl.input.removeListener('data', onData);
        rl.output.write('\n');
        rl.close();
        resolve(answer.trim());
      });
      return;
    }
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function usage() {
  console.log(`
${GREEN}ssh-manager vault${RESET} — encrypted credential store

  ${GREEN}list${RESET}                      Servers held in the vault
  ${GREEN}add${RESET} <name>                Add or replace a server
  ${GREEN}remove${RESET} <name>             Delete a server
  ${GREEN}import${RESET} [--from <path>]    Copy servers from a .env into the vault
  ${GREEN}status${RESET}                    Where the vault and its key live

${DIM}Secrets are encrypted with AES-256-GCM. The key lives in your OS keychain
when there is one, otherwise in a 0600 file next to the vault.
Set SSH_MANAGER_KEY_SOURCE=file to skip the keychain (CI, containers).${RESET}
`);
}

async function cmdList(store) {
  const names = store.listServers();
  if (names.length === 0) {
    console.log(`${YELLOW}The vault is empty.${RESET} Add a server with: ssh-manager vault add <name>`);
    console.log(`${DIM}Or copy what you already have: ssh-manager vault import${RESET}`);
    return;
  }
  const raw = store.read();
  console.log(`\n${GREEN}${names.length} server(s) in the vault${RESET}  ${DIM}${store.vaultPath}${RESET}\n`);
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

  const answer = await ask(`\nImport these into the vault? The .env is left untouched. [y/N] `);
  if (answer.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  for (const [name, config] of servers) {
    // `name` is injected by the loader for its own bookkeeping; it is the key.
    const { name: _ignored, ...rest } = config;
    store.setServer(name, rest);
  }

  console.log(`\n${GREEN}✓${RESET} ${servers.size} server(s) imported and encrypted.`);
  console.log(`${DIM}The vault now takes precedence over ${envPath}.`);
  console.log(`Once you have checked everything works, you can remove the secrets from that file.${RESET}`);
}

function cmdStatus(store) {
  const { source } = resolveMasterKey();
  const exists = store.exists();
  const socketPath = defaultSocketPath();
  const listening = isControlPlaneListening(socketPath);
  console.log(`
${GREEN}Vault${RESET}      ${store.vaultPath} ${exists ? `${DIM}(${store.listServers().length} server(s))${RESET}` : `${YELLOW}— not created yet${RESET}`}
${GREEN}Key${RESET}        ${source === 'keychain' ? `OS keychain ${DIM}(service: mcp-ssh-manager)${RESET}` : `${YELLOW}file${RESET} ${DIM}${path.join(path.dirname(store.vaultPath), 'vault.key')}${RESET}`}
${GREEN}Cipher${RESET}     AES-256-GCM ${DIM}(authenticated: tampering is detected, not silently accepted)${RESET}
${GREEN}Encrypted${RESET}  ${SECRET_FIELDS.join(', ')}

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
  case 'status': cmdStatus(store); break;
  default: usage(); process.exit(command ? 1 : 0);
  }
}

main().catch(error => {
  console.error(`${RED}${error.message}${RESET}`);
  process.exit(1);
});
