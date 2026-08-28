// The logger writes to ~/.ssh-manager.log AND to stderr, which the MCP host
// captures. Anything handed to it as structured data is therefore persisted in
// two places outside our control, so a single call site passing a whole server
// config would put a production password on disk. CodeQL flagged the path
// (js/clear-text-logging, src/logger.js).
//
// The fix redacts structurally inside the logger rather than at each call site.
// This test locks that: secrets are unreadable in the output, non-secrets are
// untouched, and the redaction cannot be defeated by nesting, arrays, casing,
// or a cyclic object.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The logger is a module-level singleton configured from the environment, so
// point it at a scratch file before importing it.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mgr-redact-'));
const LOG_FILE = path.join(LOG_DIR, 'test.log');
process.env.SSH_LOG_FILE = LOG_FILE;
process.env.SSH_LOG_LEVEL = 'DEBUG';
process.env.SSH_VERBOSE = 'true';
const { logger } = await import('../src/logger.js');

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const SECRET = 'hunter2-prod-password';

// Captures everything the logger writes, to both destinations.
function captureLog(message, data) {
  fs.writeFileSync(LOG_FILE, '');

  const originalError = console.error;
  let stderr = '';
  console.error = (...args) => { stderr += args.join(' ') + '\n'; };
  try {
    logger.info(message, data);
  } finally {
    console.error = originalError;
  }

  const file = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  return { stderr, file, both: stderr + file };
}

function testSecretsNeverReachEitherDestination() {
  const { stderr, file, both } = captureLog('connecting', {
    host: 'web-01-prod',
    user: 'deploy',
    password: SECRET
  });

  assert.ok(!stderr.includes(SECRET), 'the password must not reach stderr (the MCP host captures it)');
  assert.ok(!file.includes(SECRET), 'the password must not reach the log file');
  ok('a password is absent from both stderr and the log file');

  // Redaction must not swallow the useful context — a log that says nothing is
  // its own kind of failure.
  assert.ok(both.includes('web-01-prod'), 'the host must still be logged');
  assert.ok(both.includes('deploy'), 'the user must still be logged');
  assert.ok(both.includes('[redacted]'), 'the redaction must be visible, not silent');
  ok('non-secret fields survive, and the redaction is visible');
}

function testEverySecretSpelling() {
  // The names these values actually travel under across the codebase.
  const fields = [
    'password', 'sudoPassword', 'passphrase', 'PASSWORD', 'SSH_PASSWORD',
    'secret', 'token', 'apiKey', 'api_key', 'privateKey', 'private_key',
    'credential', 'auth'
  ];
  for (const field of fields) {
    const { both } = captureLog('probe', { [field]: SECRET });
    assert.ok(!both.includes(SECRET), `"${field}" must be redacted, it leaked`);
  }
  ok(`every secret field spelling is redacted (${fields.length} checked)`);
}

function testNestedAndArrayValues() {
  const { both } = captureLog('server list', {
    servers: [
      { name: 'web1', host: 'web-02-prod', password: SECRET },
      { name: 'web2', config: { deep: { sudoPassword: SECRET } } }
    ]
  });
  assert.ok(!both.includes(SECRET), 'secrets nested in arrays and objects must be redacted too');
  assert.ok(both.includes('web1') && both.includes('web2'), 'the surrounding structure must survive');
  ok('secrets nested inside arrays and deep objects are redacted');
}

function testCyclicObjectDoesNotHang() {
  // A server config that references its own parent would otherwise recurse
  // forever inside the logger — turning a log line into a crash.
  const cyclic = { host: 'web-02-prod', password: SECRET };
  cyclic.self = cyclic;
  const { both } = captureLog('cyclic', cyclic);
  assert.ok(!both.includes(SECRET), 'the password must still be redacted in a cyclic object');
  assert.ok(both.includes('[circular]'), 'the cycle must be marked, not followed');
  ok('a cyclic object is handled without hanging, and still redacted');
}

function testPlainMessagesAreUntouched() {
  // Redaction applies to structured data, not to the message text: rewriting
  // messages would mangle ordinary logs.
  const { both } = captureLog('Loaded SSH configuration from .env', {});
  assert.ok(both.includes('Loaded SSH configuration from .env'), 'the message must be logged verbatim');
  ok('a message with no data is logged verbatim');
}

function main() {
  testSecretsNeverReachEitherDestination();
  testEverySecretSpelling();
  testNestedAndArrayValues();
  testCyclicObjectDoesNotHang();
  testPlainMessagesAreUntouched();
  console.log(`\n✅ logger redaction tests passed (${passed} checks)`);
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
}

main();
