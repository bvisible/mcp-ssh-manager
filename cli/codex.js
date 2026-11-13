#!/usr/bin/env node
// `ssh-manager codex` — point OpenAI Codex at this engine.
//
//   ssh-manager codex setup    Write Codex's ssh-manager entry (~/.codex/config.toml)
//   ssh-manager codex status   What Codex runs today
//
// It uses the same code as the interface's AI tools panel (src/agent-clients.js): only
// the ssh-manager table of the file is replaced, every other table and comment stays,
// and the entry names the engine that npm installed. The commands were documented
// (setup, migrate, test, convert) long before they existed; setup and status are the
// two that have a meaning with the V4 engine. Idea from jaredshuai's fork, which found
// the other way of writing the entry pointing into a source checkout.
//
// Native Node rather than Bash, so it works on Windows without Git Bash.
// Exit codes: 0 done, 1 could not, 2 a command that does not exist.
import { fileURLToPath } from 'node:url';
import { agentContext, agentsStatus, useEngine } from '../src/agent-clients.js';
import { BOLD, DIM, RESET } from './style.js';

const USAGE = `
${BOLD}ssh-manager codex${RESET} — OpenAI Codex

  ssh-manager codex setup     Point Codex at this engine (the ssh-manager table of ~/.codex/config.toml)
  ssh-manager codex status    Whether Codex is installed and what its ssh-manager entry runs

${DIM}Servers for Codex: ssh-manager export servers.toml writes them in TOML.${RESET}
`;

const describe = state => (state.engine === 'npm' ? 'the npm engine' : state.engine === 'app' ? "the desktop app's engine"
  : state.engine === 'other' ? 'another ssh-manager (a checkout or a custom command)' : 'nothing yet');

/**
 * @param {string[]} args
 * @param {import('../src/agent-clients.js').Context} [context]
 * @param {{ log: (text: string) => void, error: (text: string) => void }} [out]
 * @returns {Promise<number>} the exit code
 */
export async function codexCommand(args, context = agentContext(), out = console) {
  const [command] = args;
  if (!command || ['help', '-h', '--help'].includes(command)) { out.log(USAGE); return command ? 0 : 2; }
  if (command !== 'setup' && command !== 'status') {
    out.error(`Unknown command: codex ${command}\n${USAGE}`);
    return 2;
  }
  try {
    if (command === 'status') {
      const state = (await agentsStatus(context)).clients.find(client => client.id === 'codex');
      out.log(`Codex ${state.installed ? 'is installed' : 'was not found here'}; its ssh-manager entry runs ${describe(state)}${state.version ? ` ${state.version}` : ''}.`);
      out.log(`${DIM}${state.configPath}${RESET}`);
      return 0;
    }
    const state = await useEngine('codex', 'npm', context);
    out.log(`Codex now runs ${describe(state)}${state.version ? ` ${state.version}` : ''}.`);
    out.log(`${DIM}${state.configPath}${RESET}`);
    out.log('Start a new Codex session for it to take effect.');
    return 0;
  } catch (error) {
    out.error(error.message.includes('not installed with npm')
      ? 'mcp-ssh-manager is not installed with npm here: run `npm install -g mcp-ssh-manager` first.'
      : error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  codexCommand(process.argv.slice(2)).then(code => process.exit(code));
}
