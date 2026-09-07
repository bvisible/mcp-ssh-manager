// Tests for approval notifications.
//
// The whole approval feature rests on a human seeing the request. If they are
// in another window — which they are, because they asked an agent to do the
// work so they could do something else — an unseen request sits until it times
// out and is denied. So the notification is not decoration: without it the
// queue only ever produces refusals.
//
// The module is browser code, so the browser globals it needs are stubbed here.
// What is tested is the decision-making, which is where the mistakes live: what
// gets a notification, what does not, and what happens to one whose request was
// answered somewhere else.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

let passed = 0;
function ok(label) { console.log(`\x1b[32m✓\x1b[0m ${passed + 1}. ${label}`); passed++; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every notification raised, and whether it was closed. */
const raised = [];

class FakeNotification {
  static permission = 'granted';
  static requested = 0;
  static async requestPermission() {
    FakeNotification.requested++;
    return FakeNotification.permission;
  }

  constructor(title, options = {}) {
    this.title = title;
    this.options = options;
    this.closed = false;
    this.onclick = null;
    raised.push(this);
  }

  close() { this.closed = true; }
}

globalThis.Notification = FakeNotification;
globalThis.window = { location: { search: '' }, focus() { this.focused = true; } };

/**
 * The module reads Notification.permission once at import, so each scenario
 * gets a fresh copy — importing the same URL twice returns the cached module.
 */
async function freshModule() {
  raised.length = 0;
  // A unique query string is the standard way to defeat the ESM module cache.
  const source = pathToFileURL(path.join(__dirname, '..', 'ui', 'src', 'lib', 'notify.ts'));
  const compiled = path.join(os.tmpdir(), `notify-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  // Strip the types: this is TypeScript for the bundler's benefit, and the
  // logic under test is plain JavaScript.
  const stripped = fs.readFileSync(source, 'utf8')
    .replace(/^export interface [\s\S]*?^}$/gm, '')
    .replace(/: NotificationPermission \| 'unsupported'/g, '')
    .replace(/: Promise<boolean>/g, '')
    .replace(/: ApprovalNotice/g, '')
    .replace(/: \(\) => void/g, '')
    .replace(/: string\b/g, '')
    .replace(/: void\b/g, '')
    .replace(/new Map<[^>]+>\(\)/g, 'new Map()');
  fs.writeFileSync(compiled, stripped);
  const module = await import(pathToFileURL(compiled).href);
  fs.rmSync(compiled, { force: true });
  return module;
}

const REQUEST = {
  id: 'req-1',
  server: 'production',
  tool: 'ssh_execute',
  command: 'rm -rf /var/www/releases/2026-08-12 && systemctl reload nginx',
  destructive: true,
};

async function testADestructiveRequestIsUnmistakable() {
  const notify = await freshModule();
  notify.notifyApproval(REQUEST, () => {});

  assert.strictEqual(raised.length, 1, 'a waiting request must produce a notification');
  const [notification] = raised;
  assert.match(notification.title, /production/, 'the machine must be in the title');
  assert.match(notification.title, /destructive/i, 'and so must the fact that it destroys something');
  assert.ok(notification.options.body.includes('rm -rf'),
    'the command is what the decision is about — it belongs in the body');
  assert.strictEqual(notification.options.requireInteraction, true,
    'a destructive request must not quietly disappear while unanswered');
  assert.strictEqual(notification.options.silent, false, 'and it should make a sound');
  ok('a destructive request names the machine, shows the command, and stays put');
}

async function testAnOrdinaryRequestIsQuieter() {
  const notify = await freshModule();
  notify.notifyApproval({ ...REQUEST, destructive: false, command: 'systemctl status nginx' }, () => {});

  const [notification] = raised;
  assert.ok(!/destructive/i.test(notification.title));
  assert.strictEqual(notification.options.requireInteraction, false);
  assert.strictEqual(notification.options.silent, true,
    'or every request trains the operator to dismiss all of them, including the one that mattered');
  ok('an ordinary request is quieter — the difference is the point');
}

async function testALongCommandIsTruncatedButStillReadable() {
  const notify = await freshModule();
  const long = `rm -rf ${'/very/deep/path/that/goes/on'.repeat(20)}`;
  notify.notifyApproval({ ...REQUEST, id: 'long', command: long }, () => {});

  const body = raised[0].options.body;
  assert.ok(body.length <= 141, `the body must be truncated, got ${body.length}`);
  assert.ok(body.startsWith('rm -rf'), 'and truncated at the end, so the dangerous part still shows');
  assert.ok(body.endsWith('…'), 'with something saying it was cut');
  ok('a long command is cut at the end, never at the start');
}

async function testTheSameRequestIsNotNotifiedTwice() {
  const notify = await freshModule();
  notify.notifyApproval(REQUEST, () => {});
  notify.notifyApproval(REQUEST, () => {});
  // Every event on the stream refreshes the queue; without this guard a busy
  // agent would raise one notification per refresh for the same request.
  assert.strictEqual(raised.length, 1, 'a refresh must not re-notify what is already on screen');
  ok('a request already showing is not notified again');
}

async function testAnsweringElsewhereClosesTheNotification() {
  const notify = await freshModule();
  notify.notifyApproval(REQUEST, () => {});
  notify.clearApproval('req-1');

  assert.strictEqual(raised[0].closed, true,
    'a decision made in the window must take its notification down — otherwise it invites a second one');
  // And clearing twice must not throw.
  assert.doesNotThrow(() => notify.clearApproval('req-1'));
  assert.doesNotThrow(() => notify.clearApproval('never-existed'));
  ok('answering a request closes its notification, and clearing twice is harmless');
}

async function testClickingBringsYouToTheQueue() {
  const notify = await freshModule();
  let landed = false;
  notify.notifyApproval(REQUEST, () => { landed = true; });
  raised[0].onclick();

  assert.strictEqual(landed, true, 'clicking must open the queue, not just focus a window');
  assert.strictEqual(raised[0].closed, true, 'and take the notification down');
  ok('clicking the notification opens the queue');
}

async function testPermissionIsAskedOnceAndOnlyWhenNeeded() {
  FakeNotification.permission = 'default';
  FakeNotification.requested = 0;
  const notify = await freshModule();

  assert.strictEqual(FakeNotification.requested, 0,
    'importing the module must not prompt: a permission dialog before the user has seen the page is the one everybody denies');

  FakeNotification.permission = 'granted';
  assert.strictEqual(await notify.ensurePermission(), true);
  assert.strictEqual(FakeNotification.requested, 1);
  assert.strictEqual(await notify.ensurePermission(), true);
  assert.strictEqual(FakeNotification.requested, 1, 'and asked once, not on every request');
  ok('permission is asked once, and only when there is something to show');

  FakeNotification.permission = 'granted';
}

async function testARefusalIsRespected() {
  FakeNotification.permission = 'denied';
  const notify = await freshModule();
  assert.strictEqual(await notify.ensurePermission(), false);
  notify.notifyApproval(REQUEST, () => {});
  assert.strictEqual(raised.length, 0, 'a denied permission must not be worked around');
  ok('a refusal is respected — nothing is raised');
  FakeNotification.permission = 'granted';
}

async function main() {
  await testADestructiveRequestIsUnmistakable();
  await testAnOrdinaryRequestIsQuieter();
  await testALongCommandIsTruncatedButStillReadable();
  await testTheSameRequestIsNotNotifiedTwice();
  await testAnsweringElsewhereClosesTheNotification();
  await testClickingBringsYouToTheQueue();
  await testPermissionIsAskedOnceAndOnlyWhenNeeded();
  await testARefusalIsRespected();
  console.log(`\n✅ notification tests passed (${passed} checks)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
