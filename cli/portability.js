#!/usr/bin/env node
// `ssh-manager import` and `ssh-manager export`.
//
// Implemented in Node rather than bash because it writes to the same SecretStore
// the MCP server reads from: one code path for writing and reading, so the CLI
// and the engine can never disagree about what a server is.
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { SecretStore } from '../src/secret-store.js';
import { ConfigLoader } from '../src/config-loader.js';
import { READERS, WELL_KNOWN, importFile, readTransmit, plan } from '../src/server-import.js';
import { toCsv, toXlsx, template } from '../src/server-export.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const ask = question => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
});

function usage() {
  console.log(`
${BOLD}ssh-manager import${RESET} — bring servers in from somewhere else

  ssh-manager import <file>                 read a file, working out what it is
  ssh-manager import --from <tool>          read where that tool keeps its list
  ssh-manager import --template [file]      write a spreadsheet to fill in
  ssh-manager import <file> --format <id>   when detection guesses wrong
  ssh-manager import <file> --replace       overwrite servers of the same name

  ${BOLD}tools:${RESET}  ssh-config · filezilla · transmit
  ${BOLD}formats:${RESET} ${READERS.map(r => r.id).join(' · ')}

${BOLD}ssh-manager export${RESET} — take them out again

  ssh-manager export servers.xlsx           a spreadsheet
  ssh-manager export servers.csv            a CSV
  ssh-manager export servers.env            a .env
  ssh-manager export servers.toml           TOML, for Codex

${DIM}Passwords are never written to an export, and never read from an import.${RESET}
`);
}

/**
 * Everything currently configured, from every source, plus the loader that read
 * it — `exportToEnv` and `exportToToml` are methods on the loaded instance.
 *
 * @returns {Promise<{servers: any[], loader: ConfigLoader}>}
 */
async function currentServers() {
  const loader = new ConfigLoader();
  const servers = [...(await loader.load()).values()];
  return { servers, loader };
}

async function doImport(args) {
  const flag = name => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : (args[at + 1] || '');
  };

  if (args.includes('--template')) {
    const target = path.resolve(flag('template') || 'ssh-manager-servers.xlsx');
    fs.writeFileSync(target, template());
    console.log(`\n${GREEN}Written:${RESET} ${target}`);
    console.log(`${DIM}Fill it in, then: ssh-manager import ${path.basename(target)}${RESET}\n`);
    return;
  }

  /** @type {string[]} */
  const warnings = [];
  let servers = [];
  let source = '';
  const tool = flag('from');

  if (tool === 'transmit') {
    servers = readTransmit(warnings);
    source = 'Transmit favourites';
  } else if (tool) {
    const candidates = WELL_KNOWN[tool];
    if (!candidates) {
      console.error(`${RED}Unknown tool: ${tool}${RESET}`);
      console.error(`${DIM}Try: ${Object.keys(WELL_KNOWN).join(', ')}, transmit${RESET}`);
      process.exit(1);
    }
    const found = candidates().find(file => fs.existsSync(file));
    if (!found) {
      console.error(`${RED}Nothing found for ${tool}.${RESET} Looked in:`);
      for (const c of candidates()) console.error(`  ${c.replace(os.homedir(), '~')}`);
      process.exit(1);
    }
    const result = importFile(found);
    servers = result.servers; source = result.source; warnings.push(...result.warnings);
  } else {
    const file = args.find(a => !a.startsWith('--')
      && args[args.indexOf(a) - 1] !== '--format');
    if (!file) { usage(); process.exit(1); }
    const result = importFile(path.resolve(file), flag('format'));
    servers = result.servers; source = result.source; warnings.push(...result.warnings);
  }

  console.log(`\n${BOLD}${source}${RESET} — ${servers.length} server(s)\n`);
  if (!servers.length) {
    console.log(`${YELLOW}Nothing to import.${RESET}\n`);
    return;
  }

  const existing = (await currentServers()).servers.map(s => s.name);
  const { fresh, conflicts } = plan(servers, existing);
  const replace = args.includes('--replace');

  for (const server of fresh) {
    const where = `${server.user ? `${server.user}@` : ''}${server.host}${server.port ? `:${server.port}` : ''}`;
    console.log(`  ${GREEN}+${RESET} ${server.name.padEnd(20)} ${DIM}${where}${RESET}`);
  }
  for (const server of conflicts) {
    console.log(`  ${replace ? YELLOW + '~' : DIM + '='}${RESET} ${server.name.padEnd(20)} `
      + `${DIM}${replace ? 'will be replaced' : 'already configured — left alone'}${RESET}`);
  }
  if (warnings.length) {
    console.log(`\n${YELLOW}Notes:${RESET}`);
    for (const note of warnings.slice(0, 12)) console.log(`  ${DIM}${note}${RESET}`);
    if (warnings.length > 12) console.log(`  ${DIM}…and ${warnings.length - 12} more${RESET}`);
  }

  const writing = replace ? [...fresh, ...conflicts] : fresh;
  if (!writing.length) {
    console.log(`\n${YELLOW}Everything here is already configured.${RESET} `
      + `${DIM}Use --replace to overwrite.${RESET}\n`);
    return;
  }

  const answer = await ask(`\nWrite ${writing.length} server(s) to the vault? [y/N] `);
  if (answer !== 'y' && answer !== 'yes') {
    console.log(`${DIM}Nothing written.${RESET}\n`);
    return;
  }

  const store = new SecretStore();
  for (const server of writing) {
    const { name, ...config } = server;
    store.setServer(name, config);
  }
  console.log(`\n${GREEN}${writing.length} server(s) imported.${RESET}`);
  console.log(`${DIM}They have no password or key passphrase yet — you will be asked `
    + `on first connection, or set one with: ssh-manager vault add <name>${RESET}\n`);
}

async function doExport(args) {
  const target = args.find(a => !a.startsWith('--'));
  if (!target) { usage(); process.exit(1); }
  const file = path.resolve(target);
  const { servers, loader } = await currentServers();

  if (!servers.length) {
    console.error(`${RED}No servers configured.${RESET}`);
    process.exit(1);
  }

  const extension = path.extname(file).toLowerCase();
  switch (extension) {
  case '.xlsx': fs.writeFileSync(file, toXlsx(servers)); break;
  case '.csv': fs.writeFileSync(file, toCsv(servers), 'utf8'); break;
    // .env and .toml are the loader's own writers, so a round trip through this
    // tool produces a file it would itself have written.
  case '.toml': fs.writeFileSync(file, loader.exportToToml(), 'utf8'); break;
  case '.env': fs.writeFileSync(file, loader.exportToEnv(), 'utf8'); break;
  default:
    console.error(`${RED}Don't know how to write ${extension || 'a file with no extension'}.${RESET}`);
    console.error(`${DIM}Use .xlsx, .csv, .env or .toml${RESET}`);
    process.exit(1);
  }

  console.log(`\n${GREEN}${servers.length} server(s) written:${RESET} ${file}`);
  console.log(`${DIM}No passwords or passphrases are included.${RESET}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const run = command === 'export' ? doExport : doImport;
run(command === 'export' ? rest : process.argv.slice(2).filter(a => a !== 'import'))
  .catch(error => {
    console.error(`\n${RED}${error.message}${RESET}\n`);
    process.exit(1);
  });
