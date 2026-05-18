/**
 * Per-server append-only audit log.
 *
 * Activated only when a server's config has AUDIT_LOG (env) / audit_log (TOML)
 * set to a writable file path. No-op otherwise — pre-v3.5.0 users see zero
 * change.
 *
 * Output format: one JSON object per line (JSONL), to make the log greppable
 * and consumable by log shippers (vector, fluentbit, etc.). Rotation is
 * intentionally not handled here — use logrotate or equivalent.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Field names whose values should never appear in the audit log even if a tool
// somehow passed them through args. Case-insensitive.
const REDACT_FIELDS = new Set([
  'password',
  'passphrase',
  'sudopassword',
  'sudo_password',
  'token',
  'secret',
  'apikey',
  'api_key',
]);

const REDACTED = '***';

function sanitize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_FIELDS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = sanitize(v);
    }
  }
  return out;
}

let warnedPaths = new Set();

/**
 * Append one audit line. No-op if the server has no auditLog configured.
 * Failures are logged but never propagated — auditing must not break tool execution.
 *
 * @param {Object} serverConfig
 * @param {string} toolName
 * @param {Object} args              - tool arguments (will be sanitized)
 * @param {Object} policyResult      - { allowed, reason? } from evaluatePolicy
 * @param {Object} [executionResult] - { code, success, error? } if the tool ran
 */
export function auditLog(serverConfig, toolName, args, policyResult, executionResult) {
  if (!serverConfig || !serverConfig.auditLog) return;

  const auditPath = serverConfig.auditLog;
  const entry = {
    ts: new Date().toISOString(),
    server: serverConfig.name,
    tool: toolName,
    args: sanitize(args),
    allowed: !!policyResult.allowed,
  };
  if (policyResult.reason) entry.reason = policyResult.reason;
  if (executionResult) {
    if (typeof executionResult.code === 'number') entry.exitCode = executionResult.code;
    if (typeof executionResult.success === 'boolean') entry.success = executionResult.success;
    if (executionResult.error) entry.error = String(executionResult.error).slice(0, 500);
  }

  try {
    const dir = path.dirname(auditPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
  } catch (err) {
    // Warn once per path, then stay silent to avoid log spam if the path is
    // permanently broken (e.g. read-only filesystem).
    if (!warnedPaths.has(auditPath)) {
      warnedPaths.add(auditPath);
      logger.warn(
        `Failed to write audit log for server "${serverConfig.name}" at ${auditPath}: ${err.message} (further failures for this path will be silenced)`
      );
    }
  }
}

// Exposed for tests.
export function _resetWarnedPaths() {
  warnedPaths.clear();
}
