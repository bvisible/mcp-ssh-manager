import { isPingAlive } from '../src/ssh-manager.js';

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

console.log('\n' + YELLOW + 'Running SSH Ping Tests...' + NC + '\n');

test('plain ping is alive', () => {
  assertEqual(isPingAlive('ping'), true, 'plain ping should be alive');
});

test('quoted ping with CRLF is alive', () => {
  assertEqual(isPingAlive('"ping"\r\n'), true, 'quoted CRLF ping should be alive');
});

test('escaped quoted ping is alive', () => {
  assertEqual(isPingAlive('\\"ping\\"\\r\\n'), true, 'escaped quoted ping should be alive');
});

test('case-insensitive ping is alive', () => {
  assertEqual(isPingAlive('PING'), true, 'uppercase ping should be alive');
});

test('null/undefined-safe behavior', () => {
  assertEqual(isPingAlive(null), false, 'null should not be alive');
  assertEqual(isPingAlive(undefined), false, 'undefined should not be alive');
});

test('non-ping output is not alive', () => {
  assertEqual(isPingAlive('pong'), false, 'pong should not be alive');
});

console.log('\n' + YELLOW + 'Results:' + NC);
console.log(`  ${GREEN}Passed: ${passedTests}${NC}`);
console.log(`  ${RED}Failed: ${failedTests}${NC}`);

if (failedTests > 0) process.exit(1);
