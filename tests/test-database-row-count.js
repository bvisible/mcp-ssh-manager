import { countQueryRows, DB_TYPES } from '../src/database-manager.js';

/**
 * Regression tests for issue #45: ssh_db_query reported `row_count` one greater than the
 * real number of rows (it counted the cosmetic `[` line of the MySQL JSON wrapper, and
 * over-counted psql header/separator lines). countQueryRows() derives the count from the
 * structure each engine actually produces.
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

/**
 * Reproduce the MySQL JSON output produced by the `awk` wrapper for `n` rows:
 * a leading `[`, one `{"row":i,...}` entry per row, and `]` appended to the last entry.
 */
function mysqlJsonOutput(n) {
  if (n === 0) return '[\n]';
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push(`{"row":${i},"data":"value-${i}"}`);
  return '[\n' + entries.join(',\n') + ']';
}

console.log('\n' + YELLOW + 'Running Database Row Count Tests (issue #45)...' + NC + '\n');

// --- MySQL (JSON, the default) — the exact cases from the issue ---

test('MySQL JSON: 1 row counts as 1 (was 2)', () => {
  assertEqual(countQueryRows(mysqlJsonOutput(1), DB_TYPES.MYSQL), 1, '1 row');
});

test('MySQL JSON: 13 rows count as 13 (was 14)', () => {
  assertEqual(countQueryRows(mysqlJsonOutput(13), DB_TYPES.MYSQL), 13, '13 rows');
});

test('MySQL JSON: 0 rows count as 0 (was 2)', () => {
  assertEqual(countQueryRows(mysqlJsonOutput(0), DB_TYPES.MYSQL), 0, '0 rows');
});

test('MySQL JSON: a data value containing "{\\"row\\":" does not inflate the count', () => {
  // The entry text is anchored at line start, so look-alike content inside a cell value
  // (mysql --batch keeps each row on one line) must not be miscounted.
  const output = '[\n{"row":1,"data":"see {\\"row\\":99 inside"}]';
  assertEqual(countQueryRows(output, DB_TYPES.MYSQL), 1, 'embedded look-alike');
});

test('MySQL text format: one row per non-empty line', () => {
  assertEqual(countQueryRows('1\tfoo\n2\tbar\n3\tbaz', DB_TYPES.MYSQL, 'text'), 3, 'tabular rows');
});

// --- PostgreSQL ---

test('PostgreSQL: trusts the "(N rows)" footer', () => {
  const output = ' id | name \n----+------\n  1 | a\n  2 | b\n(2 rows)';
  assertEqual(countQueryRows(output, DB_TYPES.POSTGRESQL), 2, 'footer count');
});

test('PostgreSQL: "(0 rows)" footer counts as 0', () => {
  const output = ' id | name \n----+------\n(0 rows)';
  assertEqual(countQueryRows(output, DB_TYPES.POSTGRESQL), 0, 'empty result');
});

test('PostgreSQL: singular "(1 row)" footer counts as 1', () => {
  const output = ' id | name \n----+------\n  1 | a\n(1 row)';
  assertEqual(countQueryRows(output, DB_TYPES.POSTGRESQL), 1, 'singular footer');
});

test('PostgreSQL: without a footer, drops header and separator', () => {
  const output = ' id | name \n----+------\n  1 | a\n  2 | b';
  assertEqual(countQueryRows(output, DB_TYPES.POSTGRESQL), 2, 'fallback count');
});

// --- MongoDB ---

test('MongoDB: counts printjson documents by closing brace', () => {
  const output = '{\n\t"_id" : 1,\n\t"name" : "a"\n}\n{\n\t"_id" : 2,\n\t"name" : "b"\n}';
  assertEqual(countQueryRows(output, DB_TYPES.MONGODB), 2, 'two documents');
});

test('MongoDB: single document counts as 1', () => {
  const output = '{\n\t"_id" : 1\n}';
  assertEqual(countQueryRows(output, DB_TYPES.MONGODB), 1, 'one document');
});

// --- Empty / whitespace output for every type ---

test('empty and whitespace output counts as 0 for all types', () => {
  for (const type of [DB_TYPES.MYSQL, DB_TYPES.POSTGRESQL, DB_TYPES.MONGODB]) {
    assertEqual(countQueryRows('', type), 0, `empty string (${type})`);
    assertEqual(countQueryRows('   \n  ', type), 0, `whitespace (${type})`);
  }
});

console.log('\n' + YELLOW + 'Results:' + NC);
console.log(`  ${GREEN}Passed: ${passedTests}${NC}`);
console.log(`  ${RED}Failed: ${failedTests}${NC}`);

if (failedTests > 0) process.exit(1);
