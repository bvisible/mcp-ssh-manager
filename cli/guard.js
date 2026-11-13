#!/usr/bin/env node
// ssh-manager guard: an opt-in Claude Code hook that refuses (or asks about) an
// `ssh`, `scp`, `sftp` or remote `rsync` run from the agent's shell, because it
// would skip the approval, the policy and the audit log of the MCP tools.
// Nothing is changed unless `install` is run; `print` shows what it would do.
import {
  MODES, claudeSettingsPath, guardStatus, hookCommand, hookScriptPath, installGuard, removeGuard,
} from '../src/ssh-guard.js';

const HELP = `Usage: ssh-manager guard <command> [options]

Keep an AI agent from running ssh, scp, sftp or a remote rsync in its own shell,
where ssh-manager's approval, policy and audit log do not see it. Claude Code only.

Commands:
  install    Add the hook to Claude Code's settings (and copy its script)
  remove     Take the hook out again
  status     Say whether it is installed, and in which mode
  print      Show what install would write, and change nothing

Options:
  --mode deny|ask    deny (default) refuses the command and tells the agent to use
                     the MCP tools; ask lets you decide each time
  --settings FILE    Claude Code settings file (default: ~/.claude/settings.json,
                     or $CLAUDE_CONFIG_DIR/settings.json)
  --delete-script    With remove: also delete the copied script

This is a guard against accidents, not a security boundary: it reads the command
text. Keep SSH keys and agent sockets away from the account the agent runs as.
`;

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const [command, ...args] = process.argv.slice(2);
const settingsFile = option(args, '--settings') || claudeSettingsPath();
const mode = option(args, '--mode') || 'deny';

try {
  if (!command || ['help', '-h', '--help'].includes(command)) {
    process.stdout.write(HELP);
  } else if (command === 'install') {
    if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
    const done = installGuard({ mode, settingsFile });
    console.log(`Installed in ${done.settingsFile} (mode: ${done.mode}).`);
    console.log(`The hook script is ${done.script}.`);
    console.log('Restart the Claude Code sessions that are open for it to apply.');
  } else if (command === 'remove') {
    const done = removeGuard({ settingsFile, deleteScript: args.includes('--delete-script') });
    console.log(done.removed ? `Removed from ${done.settingsFile}.` : `Nothing to remove in ${done.settingsFile}.`);
  } else if (command === 'status') {
    const status = guardStatus({ settingsFile });
    console.log(status.installed ? `Installed in ${status.settingsFile} (mode: ${status.mode}).` : `Not installed (${status.settingsFile}).`);
    if (status.installed && !status.scriptPresent) console.log('The hook script is missing: run `ssh-manager guard install` again.');
  } else if (command === 'print') {
    if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
    console.log(`Would add to ${settingsFile}:\n`);
    console.log(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand(hookScriptPath(), mode) }] }] } }, null, 2));
    console.log('\nNothing was changed.');
  } else {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
