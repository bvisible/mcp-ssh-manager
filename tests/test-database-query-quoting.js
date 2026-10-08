import {
  buildHeredoc,
  buildMySQLQueryCommand,
  buildPostgreSQLQueryCommand,
  buildMongoDBQueryCommand,
  checkMongoFilter,
  isSafeQuery
} from '../src/database-manager.js';

/**
 * Regression tests for issue #44: ssh_db_query must not let the remote shell parse the
 * SQL/JS query text. The query builders now deliver the query on stdin via a single-
 * quoted heredoc, so backtick-quoted identifiers survive intact and the query cannot
 * inject shell commands.
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${NC} ${name}`);
    passedTests++;
  } catch (error) {
    console.log(`${RED}✗${NC} ${name}`);
    console.log(`  ${RED}Error: ${error.message}${NC}`);
    failedTests++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, message) {
  if (!cond) throw new Error(message);
}

const DELIM = '__MCP_SQL_EOF__';

/**
 * Extract the heredoc body delivered to stdin from a built command string.
 * The body is every line between the `<<'DELIM'` opening line and the terminator line.
 */
function extractHeredocBody(command) {
  const lines = command.split('\n');
  const start = lines.findIndex(l => l.includes(`<<'${DELIM}'`));
  assertTrue(start !== -1, `command has no heredoc opening: ${command}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l === DELIM);
  assertTrue(end !== -1, `command has no heredoc terminator on its own line: ${command}`);
  return rest.slice(0, end).join('\n');
}

// Since 4.0 the query reaches the client inside a read-only transaction.
const statement = query => query.trim().replace(/;\s*$/, '');
const mysqlBody = query => `SET SESSION TRANSACTION READ ONLY;\n${statement(query)};`;
const pgBody = query => `BEGIN TRANSACTION READ ONLY;\n${statement(query)};\nROLLBACK;`;

console.log('\n' + YELLOW + 'Running Database Query Quoting Tests (issue #44)...' + NC + '\n');

// --- MySQL (JSON format, the default) ---

test('MySQL: backtick identifier is carried verbatim on stdin, not via -e', () => {
  const query = 'SELECT a.id FROM app_table a LEFT JOIN `other-db`.notes o ON a.ext = o.ext';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), mysqlBody(query), 'heredoc body must carry the query verbatim');
  assertTrue(!cmd.includes('-e "'), 'must not interpolate query into a double-quoted -e argument');
  assertTrue(cmd.includes(`<<'${DELIM}'`), 'must use a single-quoted heredoc delimiter');
});

test('MySQL: awk JSON pipe stays on the heredoc opening line, terminator stays alone', () => {
  const query = 'SELECT 1';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  const lines = cmd.split('\n');
  const openLine = lines.find(l => l.includes(`<<'${DELIM}'`));
  assertTrue(/\| awk /.test(openLine), 'awk pipe must be on the heredoc opening line');
  assertEqual(lines[lines.length - 1], DELIM, 'last line must be the bare terminator');
});

test('MySQL: shell-substitution payload is inert inside the heredoc body', () => {
  const query = 'SELECT \'$(id)\', `whoami`';
  const cmd = buildMySQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), mysqlBody(query), 'payload must be passed verbatim, never shell-evaluated');
});

test('MySQL: non-JSON format also uses the heredoc', () => {
  const query = 'SELECT * FROM `t`';
  const cmd = buildMySQLQueryCommand({ database: 'app', query, format: 'text' });
  assertEqual(extractHeredocBody(cmd), mysqlBody(query), 'non-json body must carry the query');
  assertTrue(!cmd.includes('-e "'), 'non-json must not use -e "..."');
  assertTrue(!/\| awk /.test(cmd), 'non-json must not pipe through awk');
});

// --- PostgreSQL ---

test('PostgreSQL: query carried via heredoc, not -c "..."', () => {
  const query = 'SELECT * FROM "weird-table" WHERE x = $1';
  const cmd = buildPostgreSQLQueryCommand({ database: 'app', query });
  assertEqual(extractHeredocBody(cmd), pgBody(query), 'pg heredoc body must carry the query');
  assertTrue(!cmd.includes('-c "'), 'must not interpolate query into -c "..."');
});

// --- MongoDB ---

test('MongoDB: find script carried via heredoc, not --eval "..."', () => {
  const query = '{name: "a`b`c"}';
  const cmd = buildMongoDBQueryCommand({ database: 'app', collection: 'users', query });
  const body = extractHeredocBody(cmd);
  assertEqual(body, `db.getCollection("users").find(${query}).forEach(printjson)`, 'mongo body must embed query verbatim');
  assertTrue(!cmd.includes('--eval "'), 'must not interpolate query into --eval "..."');
});

test('MongoDB: empty query defaults to find({})', () => {
  const cmd = buildMongoDBQueryCommand({ database: 'app', collection: 'users' });
  assertEqual(extractHeredocBody(cmd), 'db.getCollection("users").find({}).forEach(printjson)', 'default find must be {}');
});

// --- buildHeredoc defensive guard ---

test('buildHeredoc throws when the body contains a delimiter-only line', () => {
  let threw = false;
  try {
    buildHeredoc(`SELECT 1\n${DELIM}\nSELECT 2`);
  } catch {
    threw = true;
  }
  assertTrue(threw, 'a body line equal to the delimiter must be rejected');
});

test('buildHeredoc emits the pipeline on the opening line', () => {
  const frag = buildHeredoc('SELECT 1', { pipeline: '| awk "{print}"' });
  assertTrue(frag.startsWith(` <<'${DELIM}' | awk "{print}"\n`), 'pipeline must follow the marker on line one');
  assertTrue(frag.endsWith(`\n${DELIM}`), 'fragment must end with the bare terminator');
});

// --- Stochastic: random metacharacter-laden queries are delivered verbatim ---

test('stochastic: random shell-metacharacter queries round-trip verbatim through the heredoc', () => {
  // Single-line tokens only (heredoc bodies are line-oriented); include the metacharacters
  // that the old double-quoted construction would have evaluated.
  // No `;`: since 4.0 a second statement is refused before anything is built.
  const alphabet = 'abcXYZ012 .`$()\'"-_*=,:[]{}';
  const randToken = () => {
    const len = 1 + Math.floor(Math.random() * 12);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  };

  for (let i = 0; i < 500; i++) {
    // Build a SELECT query that passes isSafeQuery (starts with SELECT, no mutating keywords).
    const query = `SELECT ${randToken()} ${randToken()}`;
    const cmd = buildMySQLQueryCommand({ database: 'db', query });
    assertEqual(extractHeredocBody(cmd), mysqlBody(query), `iteration ${i}: body must carry the query verbatim`);
    // The terminator must remain alone on the final line (never broken by the payload).
    assertEqual(cmd.split('\n').pop(), DELIM, `iteration ${i}: terminator must stay on its own line`);
  }
});

// --- Read-only means read-only (GHSA-9w6j-vg8f-hp8g, GHSA-q37w-vhpx-q5q9) ---

test('SQL: a SELECT that writes is refused before anything is built', () => {
  for (const query of [
    "SELECT 'x' INTO OUTFILE '/tmp/x'",
    "SELECT 'x' INTO DUMPFILE '/tmp/x'",
    'SELECT 1 INTO @v',
    'select * into new_table from t',
    'SELECT 1; DROP TABLE t',
    'SELECT 1;\nUPDATE t SET a = 1',
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    'UPDATE t SET a = 1',
    '',
  ]) {
    assertEqual(isSafeQuery(query), false, query);
    let threw = false;
    try { buildMySQLQueryCommand({ database: 'app', query }); } catch { threw = true; }
    assertTrue(threw, `the MySQL builder must refuse ${JSON.stringify(query)}`);
  }
});

test('SQL: ordinary SELECTs still pass, including names that merely contain a verb', () => {
  for (const query of ['SELECT 1', 'SELECT 1;', 'select updated_at, created_by FROM t', 'SELECT * FROM t WHERE note LIKE \'%x%\'']) {
    assertEqual(isSafeQuery(query), true, query);
  }
  assertEqual(extractHeredocBody(buildPostgreSQLQueryCommand({ database: 'app', query: 'SELECT 1;' })), pgBody('SELECT 1'),
    'a trailing semicolon is not doubled');
});

test('MongoDB: a filter that is code is refused, a collection name stays a name', () => {
  for (const query of [
    '{}).forEach(printjson); run("touch","/tmp/PWNED"); db.x.find({}',
    '{a: db.dropDatabase()}', '{a: function(){ return 1 }}', '{a: 1 + 1}', '{a: this.b}',
    '{$where: "sleep(1000)"}', '{"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}',
    '{a: ObjectId(db.x)}', '{a: 1}; db.x.drop()', '[{}]', '{a: `x`}',
  ]) {
    let threw = false;
    try { buildMongoDBQueryCommand({ database: 'app', collection: 'users', query }); } catch { threw = true; }
    assertTrue(threw, `must refuse ${JSON.stringify(query)}`);
  }
  for (const query of ['{}', '{"a": 1}', '{name: "x", age: {$gte: 18}}', '{_id: ObjectId("507f1f77bcf86cd799439011")}',
    '{d: {$lt: ISODate("2026-01-01")}}', '{n: /^a.*/i}', "{'k': 'v', list: [1, 2.5, -3e2, null, true]}", '{d: new Date("2026-01-01")}']) {
    assertEqual(checkMongoFilter(query), query, query);
  }
  const body = extractHeredocBody(buildMongoDBQueryCommand({ database: 'app', collection: 'users.drop(); db.secrets', query: '{}' }));
  assertEqual(body, 'db.getCollection("users.drop(); db.secrets").find({}).forEach(printjson)', 'the collection is a string literal');
});

console.log('\n' + YELLOW + 'Results:' + NC);
console.log(`  ${GREEN}Passed: ${passedTests}${NC}`);
console.log(`  ${RED}Failed: ${failedTests}${NC}`);

if (failedTests > 0) process.exit(1);
