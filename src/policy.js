/**
 * Per-server security policy evaluation.
 *
 * Three modes, opt-in per server via config (MODE field):
 *   - "unrestricted" (default): no change vs. pre-v3.5.0 behavior. Early-return.
 *   - "readonly":   blocks mutating tools entirely; for ssh_execute / ssh_execute_sudo /
 *                   ssh_execute_group / ssh_session_send, blocks commands matching the
 *                   built-in destructive denylist below.
 *   - "restricted": every command on the line (each part of a list or pipeline)
 *                   must match at least one ALLOW_PATTERNS regex, and neither the
 *                   line nor any of its commands may match a DENY_PATTERNS regex.
 *                   DENY wins over ALLOW. Command substitution and redirections
 *                   that write a file are refused: they run or change things the
 *                   patterns never see.
 *
 * Returns { allowed: boolean, reason?: string } — never throws. Callers translate
 * a refusal into an MCP-level error response.
 */

import { logger } from './logger.js';
import { splitShellCommand } from './shell-segments.js';

const MODE_UNRESTRICTED = 'unrestricted';
const MODE_READONLY = 'readonly';
const MODE_RESTRICTED = 'restricted';

export const VALID_MODES = new Set([MODE_UNRESTRICTED, MODE_READONLY, MODE_RESTRICTED]);

// Tools that mutate remote state and are unconditionally blocked in readonly mode.
// Read-only tools (ssh_download, ssh_list_servers, ssh_health_check, ssh_db_query, ssh_tail,
// ssh_monitor, ssh_history, ssh_*_list, ssh_*_status, ssh_db_list) are not listed and
// pass through.
export const READONLY_BLOCKED_TOOLS = new Set([
  'ssh_upload',
  'ssh_deploy',
  'ssh_sync',
  'ssh_execute_sudo',
  'ssh_backup_create',
  'ssh_backup_restore',
  'ssh_backup_schedule',
  'ssh_db_import',
  'ssh_db_dump',
  'ssh_key_manage',
  'ssh_alert_setup',
  'ssh_process_manager',
]);

// Tools whose command argument we want to filter against the readonly built-in
// denylist and the restricted ALLOW/DENY regexes.
export const COMMAND_BEARING_TOOLS = new Set([
  'ssh_execute',
  'ssh_execute_sudo',
  'ssh_execute_group',
  'ssh_session_send',
]);

// Built-in destructive command regex denylist applied in readonly mode to any
// command passed to a COMMAND_BEARING_TOOL. Patterns are intentionally simple
// substring/word matches — not a security boundary, just a guard rail against
// accidental destructive commands when an operator opts a server into readonly.
//
// The user can layer their own DENY_PATTERNS on top via restricted mode for
// finer control.
const READONLY_DENY_REGEX = [
  /(^|[\s;&|])rm(\s|$)/,
  /(^|[\s;&|])rmdir(\s|$)/,
  /(^|[\s;&|])mv(\s|$)/,
  /(^|[\s;&|])dd(\s|$)/,
  /(^|[\s;&|])mkfs(\.|\s|$)/,
  /(^|[\s;&|])chmod(\s|$)/,
  /(^|[\s;&|])chown(\s|$)/,
  /(^|[\s;&|])truncate(\s|$)/,
  /(^|[\s;&|])tee(\s|$)/,
  /(^|[\s;&|])sudo(\s|$)/,
  /(^|[\s;&|])su(\s|$)/,
  /(^|[\s;&|])kill(\s|$)/,
  /(^|[\s;&|])pkill(\s|$)/,
  /(^|[\s;&|])killall(\s|$)/,
  /(^|[\s;&|])shutdown(\s|$)/,
  /(^|[\s;&|])reboot(\s|$)/,
  /(^|[\s;&|])halt(\s|$)/,
  /(^|[\s;&|])poweroff(\s|$)/,
  /(^|[\s;&|])systemctl\s+(restart|stop|reload|start|enable|disable|mask)/,
  /(^|[\s;&|])service\s+\S+\s+(restart|stop|reload|start)/,
  /(^|[\s;&|])docker\s+(rm|stop|restart|kill|prune|system)/,
  /(^|[\s;&|])apt(-get)?\s+(install|remove|purge|upgrade|update)/,
  /(^|[\s;&|])yum\s+(install|remove|update|upgrade)/,
  /(^|[\s;&|])dnf\s+(install|remove|update|upgrade)/,
  /(^|[\s;&|])pip\s+(install|uninstall)/,
  /(^|[\s;&|])npm\s+(install|uninstall|publish)/,
  /(^|[\s;&|])git\s+(reset\s+--hard|push\s+.*--force|clean\s+-fd?)/,
  />\s*\/(?!dev\/null|dev\/stdout|dev\/stderr|tmp)/, // redirect to non-tmp/non-devnull file
  />>\s*\/(?!dev\/null|tmp)/,                          // append-redirect to non-tmp file
  /\|\s*sh(\s|$)/,
  /\|\s*bash(\s|$)/,
  /curl\s+[^|]*\|\s*(sh|bash)/,
  /wget\s+[^|]*\|\s*(sh|bash)/,
];

/**
 * Compile a list of regex source strings into RegExp objects.
 * Invalid regexes are logged and skipped (returned list may be shorter than input).
 *
 * @param {string[]} patterns
 * @param {string} contextLabel - for log messages ("ALLOW" / "DENY")
 * @param {string} serverName
 * @returns {RegExp[]}
 */
function compilePatterns(patterns, contextLabel, serverName) {
  const compiled = [];
  for (const src of patterns) {
    if (!src || typeof src !== 'string') continue;
    try {
      compiled.push(new RegExp(src));
    } catch (err) {
      logger.warn(
        `Invalid ${contextLabel}_PATTERNS regex for server "${serverName}": /${src}/ — ignored (${err.message})`
      );
    }
  }
  return compiled;
}

// Per-server compiled-regex cache, keyed by server name. Patterns rarely change at runtime
// (they're loaded once from config), so this avoids recompiling on every tool call.
const compiledCache = new Map();

function getCompiledPatterns(serverConfig) {
  const key = serverConfig.name;
  const cached = compiledCache.get(key);
  // Cache invalidation: if the raw pattern strings change, drop the cached entry.
  if (
    cached &&
    cached.allowSrc === (serverConfig.allowPatterns || []).join('') &&
    cached.denySrc === (serverConfig.denyPatterns || []).join('')
  ) {
    return cached;
  }
  const allow = compilePatterns(serverConfig.allowPatterns || [], 'ALLOW', key);
  const deny = compilePatterns(serverConfig.denyPatterns || [], 'DENY', key);
  const entry = {
    allow,
    deny,
    allowSrc: (serverConfig.allowPatterns || []).join(''),
    denySrc: (serverConfig.denyPatterns || []).join(''),
  };
  compiledCache.set(key, entry);
  return entry;
}

/**
 * Evaluate whether a tool invocation is allowed under the server's policy.
 *
 * Performance: in the common case (mode === 'unrestricted' or undefined), this
 * returns immediately with no allocations beyond the result object.
 *
 * @param {Object} serverConfig - the server config object from config-loader.js
 * @param {string} toolName     - MCP tool name (e.g. "ssh_execute")
 * @param {string} [command]    - optional command string for COMMAND_BEARING_TOOLS
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluatePolicy(serverConfig, toolName, command) {
  // Backward-compat fast path: no server config, missing mode, or unrestricted mode
  // → identical behavior to pre-v3.5.0. Not a single regex is compiled or matched.
  const mode = serverConfig && serverConfig.mode;
  if (!mode || mode === MODE_UNRESTRICTED) {
    return { allowed: true };
  }

  if (mode === MODE_READONLY) {
    if (READONLY_BLOCKED_TOOLS.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is disabled on server "${serverConfig.name}" (mode: readonly).`,
      };
    }
    if (COMMAND_BEARING_TOOLS.has(toolName) && typeof command === 'string') {
      // The whole line, then each command in it, including those inside $(…)
      // and backticks: `echo $(rm -rf x)` has no space before its `rm`.
      const { segments, substitutions } = splitShellCommand(command);
      for (const text of [command, ...segments, ...substitutions]) {
        for (const re of READONLY_DENY_REGEX) {
          if (re.test(text)) {
            return {
              allowed: false,
              reason: `Command refused on server "${serverConfig.name}" (mode: readonly): matches built-in destructive pattern ${re}.`,
            };
          }
        }
      }
    }
    return { allowed: true };
  }

  if (mode === MODE_RESTRICTED) {
    const { allow, deny } = getCompiledPatterns(serverConfig);

    // For non-command-bearing tools in restricted mode, fall back to readonly semantics
    // (block mutating tools, allow read-only tools). This means restricted mode is a
    // strict superset of readonly's tool-level blocks plus command-level allowlisting.
    if (!COMMAND_BEARING_TOOLS.has(toolName)) {
      if (READONLY_BLOCKED_TOOLS.has(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is disabled on server "${serverConfig.name}" (mode: restricted blocks mutating tools by default).`,
        };
      }
      return { allowed: true };
    }

    if (typeof command !== 'string') {
      // Defensive: command-bearing tool called without a command? Refuse.
      return {
        allowed: false,
        reason: `Tool "${toolName}" requires a command argument under restricted mode.`,
      };
    }

    const refuse = why => ({
      allowed: false,
      reason: `Command refused on server "${serverConfig.name}" (mode: restricted): ${why}.`,
    });

    // Each pattern is tested against every command on the line, not the line
    // as a whole: tested against the line, `^docker ps` only checked how it
    // started, and `docker ps; id` passed (GHSA-rfxw-26h6-7w42).
    const { segments, substitutions, writes, problem } = splitShellCommand(command);

    for (const re of deny) {
      for (const text of [command, ...segments]) {
        if (re.test(text)) return refuse(`matches DENY pattern ${re}`);
      }
    }

    if (allow.length === 0) {
      return refuse('no ALLOW_PATTERNS configured — restricted mode requires an explicit allowlist');
    }

    if (problem) return refuse(`the command could not be checked (${problem})`);
    if (substitutions.length) {
      return refuse('command substitution ($(…), backticks, <(…)) runs commands the allowlist cannot check');
    }
    if (writes.length) {
      return refuse(`redirecting output to "${writes[0]}" writes a file, which restricted mode does not allow`);
    }
    if (!segments.length) return refuse('empty command');

    for (const segment of segments) {
      if (!allow.some(re => re.test(segment))) {
        return refuse(segments.length > 1
          ? `"${segment}" does not match any ALLOW_PATTERNS (every command in a list or pipeline must)`
          : 'does not match any ALLOW_PATTERNS');
      }
    }
    return { allowed: true };
  }

  // Unknown mode — fail-closed with a clear message rather than silently allowing.
  return {
    allowed: false,
    reason: `Unknown security mode "${mode}" for server "${serverConfig.name}". Valid: ${[...VALID_MODES].join(', ')}.`,
  };
}

// Exposed for tests only.
export function _clearCompiledCache() {
  compiledCache.clear();
}
