// The control plane — the thing that answers "what did my agents do on my
// servers, and what am I letting them do next".
//
// It is two servers in one process:
//
//   * a **stream socket** the engine connects to when it needs a decision
//     (the protocol in approval.js), and
//   * a **local HTTP server** serving one page and a small API, so a human can
//     see the queue and decide.
//
// It is deliberately not an Electron app and adds no dependency: Node's http
// and net, plus one HTML file. That keeps it runnable anywhere the engine runs
// — including on a server, reached through the SSH tunnels this project already
// manages — and leaves the door open to wrapping it in a desktop shell later.
//
// ## Why the token is not optional
//
// This process approves root shell commands. An unauthenticated HTTP server on
// localhost is reachable by **every process on the machine, and by any web page
// the user has open** (a page can POST to 127.0.0.1). Without a secret in the
// URL, a visited website could approve an agent's `rm -rf`. So:
//
//   * a random token is required on every request,
//   * the Host header must be a loopback literal, which blocks DNS rebinding,
//   * the listener binds 127.0.0.1 explicitly, never 0.0.0.0.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { safeInteger } from './shell-quote.js';
import { SecretStore, defaultVaultPath, SECRET_FIELDS } from './secret-store.js';
import { ConfigLoader } from './config-loader.js';
import { StreamRegistry, listenForStreams, streamSocketPath } from './live-stream.js';
import { MAX_SOCKET_PATH } from './approval.js';
import SSHManager from './ssh-manager.js';
import { buildComprehensiveHealthCheckCommand, parseComprehensiveHealthCheck } from './health-monitor.js';
import { listKnownHosts, removeHostKey } from './ssh-key-manager.js';
import { listGroups, getGroup, createGroup, updateGroup, deleteGroup, executeOnGroup, setServerConfigProvider } from './server-groups.js';
import { readPublishedTunnels } from './tunnel-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Host headers accepted. Anything else is a rebinding attempt or a mistake. */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** How many audit entries the timeline holds in memory. */
const TIMELINE_LIMIT = 500;

/**
 * A pending decision: the engine is blocked on this until someone answers.
 * @typedef {Object} PendingRequest
 * @property {Object} request - What the engine asked
 * @property {(decision: string, reason?: string) => void} settle - Answer it
 * @property {number} receivedAt - Epoch ms, for showing how long it has waited
 */

/**
 * How much terminal output is replayed to a screen that attaches late. Enough
 * for a login banner and a screenful, small enough that idle shells cost little.
 */
const TERMINAL_BACKLOG_BYTES = 64 * 1024;

/**
 * How long an idle SFTP connection is kept. Long enough that browsing feels
 * instant, short enough that walking away closes the session.
 */
const SFTP_IDLE_MS = 5 * 60 * 1000;

/** Where `npm run build:ui` puts the built interface. */
const APP_DIR = path.resolve(__dirname, '..', 'dist', 'ui');



/**
 * A pooled SFTP session can stop answering without ever failing: the machine
 * went away, the network moved, the far end was killed. ssh2 has no deadline of
 * its own for a request in flight, so the screen would sit on "Loading…"
 * forever — which is worse than an error, because the operator cannot tell it
 * apart from a slow directory.
 *
 * @template T
 * @param {Promise<T>} work - The operation in flight
 * @param {number} [ms] - How long to wait
 * @returns {Promise<T>}
 */
function withTimeout(work, ms = 15000) {
  return Promise.race([
    work,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('The server stopped answering')), ms).unref()),
  ]);
}


/**
 * Whether a group exists, without the exception.
 *
 * `getGroup` throws for an unknown name — reasonable for a tool call, wrong as
 * a test, and using it as one made every "create" report the group missing.
 *
 * @param {string} name - Group name
 * @returns {any|null}
 */
function findGroup(name) {
  try {
    return getGroup(name);
  } catch {
    return null;
  }
}

/** @param {any} sftp - SFTP session @param {string} dir - Path to resolve */
function realpath(sftp, dir) {
  return new Promise(resolve => {
    sftp.realpath(dir, (/** @type {Error|null} */ error, /** @type {string} */ resolved) =>
      resolve(error ? dir : resolved));
  });
}

/** @param {any} sftp - SFTP session @param {string} dir - Directory to list */
function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (/** @type {Error|null} */ error, /** @type {any[]} */ list) =>
      (error ? reject(error) : resolve(list)));
  });
}

/**
 * One SFTP entry as a file browser wants it: types decoded from the POSIX mode,
 * times in milliseconds, and the full path already joined so the caller never
 * has to guess how to join at the root.
 *
 * @param {string} dir - The directory being listed
 * @param {any} item - An ssh2 directory entry
 */
function describe(dir, item) {
  const attrs = item.attrs || {};
  const mode = attrs.mode || 0;
  const S_IFMT = 0o170000;
  return {
    name: item.filename,
    path: dir === '/' ? `/${item.filename}` : `${dir}/${item.filename}`,
    size: attrs.size ?? 0,
    isDirectory: (mode & S_IFMT) === 0o040000,
    isSymlink: (mode & S_IFMT) === 0o120000,
    modifyTime: (attrs.mtime ?? 0) * 1000,
    accessTime: (attrs.atime ?? 0) * 1000,
    permissions: mode & 0o7777,
    owner: attrs.uid ?? 0,
    group: attrs.gid ?? 0,
  };
}

export class ControlPlane {
  /**
   * @param {Object} options - Configuration
   * @param {string} options.socketPath - Where the engine connects
   * @param {number} [options.port] - HTTP port; 0 picks a free one
   * @param {string[]} [options.auditPaths] - JSONL audit logs to read
   * @param {string} [options.vaultPath] - Encrypted store to manage servers in
   */
  constructor({ socketPath, port = 0, auditPaths = [], vaultPath = defaultVaultPath() }) {
    this.socketPath = socketPath;
    this.port = port;
    this.auditPaths = auditPaths;
    this.store = new SecretStore(vaultPath);
    // Live command output from the engine, kept with a bounded scrollback so a
    // window opened mid-command still shows what came before.
    this.streams = new StreamRegistry();
    this.streamServer = null;
    // Interactive shells opened from the terminal screen, keyed by id.
    /** @type {Map<string, {ssh: any, stream: any, server: string, subscribers: Set<import('http').ServerResponse>, backlog: string[], backlogBytes: number}>} */
    this.terminals = new Map();

    // SFTP connections, kept alive between requests. A file manager makes tens
    // of calls to browse one directory tree, and an SSH handshake per `ls` —
    // several hundred milliseconds each — would make the screen unusable. Idle
    // connections are dropped after SFTP_IDLE_MS so nothing stays open on a
    // machine nobody is looking at.
    /** @type {Map<string, {ssh: any, sftp: any, timer: NodeJS.Timeout|null}>} */
    this.sftpPool = new Map();

    /** @type {string|null} The tokenised URL, once the server is listening. */
    this.url = null;
    this.token = crypto.randomBytes(24).toString('hex');

    /** @type {Map<string, PendingRequest>} */
    this.pending = new Map();
    /** @type {Object[]} */
    this.timeline = [];
    /** @type {Set<import('http').ServerResponse>} */
    this.subscribers = new Set();

    this.socketServer = null;
    this.httpServer = null;
    /** @type {Map<string, number>} */
    this.auditOffsets = new Map();
    this.auditTimer = null;
  }

  /**
   * Start both servers.
   * @returns {Promise<{url: string, socketPath: string}>} Where to point a browser
   */
  async start() {
    // Groups are the union of .server-groups.json and the per-server `group`
    // field, so the group layer needs to know what servers exist. Wired here
    // rather than inside the options handler: the write routes need it too, and
    // without it they cannot tell a config-derived group from an unknown one.
    setServerConfigProvider(() => {
      try {
        const raw = this.store.read();
        return Object.fromEntries(
          Object.entries(raw.servers).map(([name, config]) => [name, { ...config, name }])
        );
      } catch {
        // An unreadable vault means no config-derived groups, not a failure.
        return {};
      }
    });

    // Checked before binding, because bind() reports an over-long path as
    // EADDRINUSE — an error that sends you looking for a process that does not
    // exist, on a socket file that is not there. macOS/BSD cap sun_path at 104
    // bytes, and a project checked out under a long path reaches that easily.
    for (const [label, socket] of [['approval', this.socketPath], ['stream', streamSocketPath()]]) {
      const size = Buffer.byteLength(socket);
      if (size > MAX_SOCKET_PATH) {
        throw new Error(
          `The ${label} socket path is ${size} bytes, over the ${MAX_SOCKET_PATH}-byte limit for Unix sockets: `
          + `${socket}\nSet SSH_MANAGER_HOME to a shorter directory.`
        );
      }
    }
    await this.#startSocketServer();
    await this.#startStreamServer();
    const url = await this.#startHttpServer();
    this.#startAuditTail();
    return { url, socketPath: this.socketPath };
  }

  async #startStreamServer() {
    this.streamServer = await listenForStreams(this.streams);
    // Push every stream event straight to open pages: this is the "watch the
    // agent work" path, and buffering it would defeat the point.
    this.streams.subscribe(event => this.#broadcast({ type: 'stream', event }));
  }

  /** Stop everything and release the socket. */
  async stop() {
    if (this.auditTimer) clearInterval(this.auditTimer);
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();

    // Answer anything still waiting rather than leaving the engine hanging on a
    // socket that is about to disappear.
    for (const [, entry] of this.pending) {
      entry.settle('deny', 'Control plane shutting down');
    }
    this.pending.clear();

    // Interactive shells hold an SSH connection each; leaving them would leak
    // a session per terminal ever opened.
    for (const id of [...this.terminals.keys()]) this.#disposeTerminal(id);
    for (const name of [...this.sftpPool.keys()]) this.#releaseSftp(name);

    await Promise.all([
      new Promise(resolve => (this.socketServer ? this.socketServer.close(() => resolve(undefined)) : resolve(undefined))),
      new Promise(resolve => (this.httpServer ? this.httpServer.close(() => resolve(undefined)) : resolve(undefined))),
      new Promise(resolve => (this.streamServer ? this.streamServer.close(() => resolve(undefined)) : resolve(undefined))),
    ]);
    for (const socket of [this.socketPath, streamSocketPath()]) {
      try { fs.unlinkSync(socket); } catch { /* already gone */ }
    }
  }

  async #startSocketServer() {
    // A socket left behind by a crash makes bind() fail; clearing it is what
    // lets the control plane restart without manual cleanup.
    try {
      if (fs.statSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
    } catch { /* nothing there */ }

    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });

    this.socketServer = net.createServer(socket => this.#handleEngineConnection(socket));
    await new Promise((resolve, reject) => {
      this.socketServer?.once('error', reject);
      this.socketServer?.listen(this.socketPath, () => resolve(undefined));
    });
    // Only this user may ask us to decide.
    try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
  }

  /**
   * One engine connection carries one request and waits for one reply.
   * @param {import('net').Socket} socket - The engine's connection
   */
  #handleEngineConnection(socket) {
    let buffer = '';
    let handled = false;

    socket.on('data', chunk => {
      if (handled) return;
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;

      /** @type {any} */
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch (error) {
        logger.warn('Unreadable approval request', { error: error.message });
        socket.destroy();
        return;
      }

      const settle = (decision, reason) => {
        if (socket.destroyed) return;
        socket.write(`${JSON.stringify({ id: request.id, decision, reason })}\n`);
        socket.end();
        this.pending.delete(request.id);
        this.#broadcast({ type: 'resolved', id: request.id, decision, reason });
        this.#record({
          ts: new Date().toISOString(),
          server: request.server,
          tool: request.tool,
          command: request.command,
          allowed: decision === 'allow',
          reason: `approval ${decision}${reason ? `: ${reason}` : ''}`,
          source: 'control-plane',
        });
      };

      this.pending.set(request.id, { request, settle, receivedAt: Date.now() });
      this.#broadcast({ type: 'pending', request });
      logger.info('Approval requested', { server: request.server, tool: request.tool });

      // If the engine gives up first (its own deadline), drop the entry so the
      // UI does not offer a decision nobody is waiting for.
      socket.on('close', () => {
        if (this.pending.has(request.id)) {
          this.pending.delete(request.id);
          this.#broadcast({ type: 'expired', id: request.id });
        }
      });
    });

    socket.on('error', () => { /* engine went away */ });
  }

  /**
   * @returns {Promise<string>} The URL to open, token included
   */
  async #startHttpServer() {
    this.httpServer = http.createServer((req, res) => this.#handleHttp(req, res));
    await new Promise((resolve, reject) => {
      this.httpServer?.once('error', reject);
      // 127.0.0.1, never 0.0.0.0: this must not be reachable from the network.
      this.httpServer?.listen(this.port, '127.0.0.1', () => resolve(undefined));
    });
    const address = /** @type {import('net').AddressInfo} */ (this.httpServer.address());
    // Port 0 asks the OS to choose; remember what it chose, or callers that
    // outlive the returned URL — a desktop window reopening, a status command —
    // have no way to build it again.
    this.port = address.port;
    this.url = `http://127.0.0.1:${address.port}/?token=${this.token}`;
    return this.url;
  }

  /**
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #handleHttp(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    // DNS rebinding: a hostile page can resolve its own domain to 127.0.0.1 and
    // reach us. The Host header is what tells the two apart.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.has(host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden host\n');
      return;
    }

    const token = url.searchParams.get('token') || req.headers['x-control-token'];
    if (typeof token !== 'string' || !this.#tokenMatches(token)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Missing or invalid token\n');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') return this.#serveApp(res);
    if (req.method === 'GET' && url.pathname === '/legacy') return this.#serveUi(res);
    if (req.method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/app.css'
      || url.pathname.startsWith('/assets/'))) return this.#serveAppAsset(url.pathname, res);
    if (req.method === 'GET' && url.pathname === '/api/state') return this.#serveState(res);
    if (req.method === 'GET' && url.pathname === '/api/events') return this.#serveEvents(res);
    if (req.method === 'POST' && url.pathname === '/api/decide') return this.#handleDecision(req, res);
    if (req.method === 'POST' && url.pathname === '/api/terminal') return this.#openTerminal(req, res);
    if (req.method === 'GET' && url.pathname === '/api/terminal/stream') return this.#streamTerminal(url.searchParams.get('id'), res);
    if (req.method === 'POST' && url.pathname === '/api/terminal/input') return this.#terminalInput(url.searchParams.get('id'), req, res);
    if (req.method === 'POST' && url.pathname === '/api/terminal/resize') return this.#terminalResize(url.searchParams.get('id'), req, res);
    if (req.method === 'DELETE' && url.pathname === '/api/terminal') return this.#closeTerminal(url.searchParams.get('id'), res);

    // Files. Deliberately not path-restricted, for the same reason the terminal
    // is not: whoever holds this token already has a shell on the machine.
    if (req.method === 'GET' && url.pathname === '/api/files') return this.#listFiles(url.searchParams, res);
    if (req.method === 'GET' && url.pathname === '/api/files/read') return this.#readFile(url.searchParams, res);
    if (req.method === 'POST' && url.pathname === '/api/files/write') return this.#writeFile(url.searchParams, req, res);
    if (req.method === 'POST' && url.pathname === '/api/files/mkdir') return this.#fileOp('mkdir', req, res);
    if (req.method === 'POST' && url.pathname === '/api/files/rename') return this.#fileOp('rename', req, res);
    if (req.method === 'POST' && url.pathname === '/api/files/delete') return this.#fileOp('delete', req, res);

    // The local side of the file browser. This process runs on the operator's
    // own machine, so it can read that machine's filesystem — which is what
    // makes a local/remote pair possible at all. A page in a browser could not,
    // but the page is not what reads the disk here.
    if (req.method === 'GET' && url.pathname === '/api/local/files') return this.#listLocal(url.searchParams, res);
    if (req.method === 'GET' && url.pathname === '/api/local/read') return this.#readLocal(url.searchParams, res);
    if (req.method === 'POST' && url.pathname === '/api/local/mkdir') return this.#localOp('mkdir', req, res);
    if (req.method === 'POST' && url.pathname === '/api/local/rename') return this.#localOp('rename', req, res);
    if (req.method === 'POST' && url.pathname === '/api/local/delete') return this.#localOp('delete', req, res);
    if (req.method === 'POST' && url.pathname === '/api/local/reveal') return this.#localOp('reveal', req, res);
    if (req.method === 'POST' && url.pathname === '/api/transfer') return this.#transfer(req, res);
    if (req.method === 'POST' && url.pathname === '/api/execute') return this.#execute(req, res);
    if (req.method === 'GET' && url.pathname === '/api/options') return this.#serveOptions(res);
    if (req.method === 'DELETE' && url.pathname === '/api/hostkey') {
      return this.#forgetHostKey(url.searchParams.get('host'), url.searchParams.get('port'), res);
    }
    if (req.method === 'POST' && url.pathname === '/api/health') {
      return this.#probeHealth(url.searchParams.get('name'), res);
    }
    if (req.method === 'GET' && url.pathname === '/api/streams') {
      const id = url.searchParams.get('id');
      return this.#json(res, 200, id ? { stream: this.streams.get(id) } : { streams: this.streams.list() });
    }
    if (req.method === 'GET' && url.pathname === '/api/servers') return this.#serveServers(res);
    if (req.method === 'GET' && url.pathname === '/api/migration') return this.#migrationState(res);
    if (req.method === 'POST' && url.pathname === '/api/groups') return this.#saveGroup(req, res);
    if (req.method === 'DELETE' && url.pathname === '/api/groups') return this.#deleteGroup(url.searchParams.get('name'), res);
    if (req.method === 'POST' && url.pathname === '/api/groups/run') return this.#runOnGroup(req, res);
    if (req.method === 'POST' && url.pathname === '/api/migration') return this.#runMigration(req, res);
    if (req.method === 'POST' && url.pathname === '/api/servers') return this.#saveServer(req, res);
    if (req.method === 'DELETE' && url.pathname === '/api/servers') {
      return this.#deleteServer(url.searchParams.get('name'), res);
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
  }

  /**
   * Constant-time token comparison, so a caller cannot learn the token one
   * character at a time from response timings.
   * @param {string} candidate - Token supplied by the caller
   * @returns {boolean} True on match
   */
  #tokenMatches(candidate) {
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(candidate);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Shown only when the built interface is missing — a source checkout that has
   * not run `npm run build:ui`.
   *
   * This used to be a second, complete implementation of every screen. Keeping
   * two of those in step is work nobody does, and the one that drifts is always
   * the one nobody looks at. A fallback that says what to run is more useful
   * than a fallback that quietly behaves differently.
   *
   * @param {import('http').ServerResponse} res - Response
   */
  #serveUi(res) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'',
    });
    res.end(`<!doctype html>
<meta charset="utf-8">
<title>SSH Manager — interface not built</title>
<style>
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 34rem; margin: 20vh auto; padding: 0 1.5rem; color: #111418; }
  code { background: #edeff3; border-radius: 4px; padding: 0.15em 0.4em; font-size: 0.9em; }
  p { color: #4a5058; }
  @media (prefers-color-scheme: dark) {
    body { background: #111418; color: #e6e8eb; } code { background: #23272e; } p { color: #99a1ab; }
  }
</style>
<h1>The interface has not been built</h1>
<p>The control plane is running and its API is answering — only the page is missing.
   This happens in a source checkout that has not built it yet.</p>
<p>From the repository root:</p>
<p><code>npm run build:ui</code></p>
<p>Then reload. An installed copy from npm ships the built interface, so this
   page should never appear there.</p>
`);
  }

  /** @param {import('http').ServerResponse} res - Response */
  #serveState(res) {
    const pending = [...this.pending.values()].map(entry => ({
      ...entry.request,
      waitingMs: Date.now() - entry.receivedAt,
    }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ pending, timeline: this.timeline.slice(-TIMELINE_LIMIT) }));
  }

  /** @param {import('http').ServerResponse} res - Response */
  #serveEvents(res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
  }

  /**
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #handleDecision(req, res) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // A decision is a few dozen bytes; anything larger is not one.
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      /** @type {any} */
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"malformed body"}');
        return;
      }

      const entry = this.pending.get(payload.id);
      if (!entry) {
        // Already answered, or the engine timed out while the page was open.
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end('{"error":"no longer pending"}');
        return;
      }

      entry.settle(payload.decision === 'allow' ? 'allow' : 'deny', payload.reason);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  }

  /**
   * Servers held in the vault.
   *
   * Never returns a secret, only whether one is set: the page is the most
   * exposed surface here, and a credential has no reason to travel to it. The
   * CLI does not print them either.
   *
   * @param {import('http').ServerResponse} res - Response
   */
  #serveServers(res) {
    /** @type {any[]} */
    let servers = [];
    try {
      const raw = this.store.read();
      servers = Object.entries(raw.servers).map(([name, config]) => {
        /** @type {Record<string, any>} */
        const safe = { name };
        for (const [field, value] of Object.entries(config)) {
          // A boolean saying "there is a password" is all the UI needs to render
          // the row and pre-fill the form sensibly.
          safe[field] = SECRET_FIELDS.includes(field) ? undefined : value;
          if (SECRET_FIELDS.includes(field)) safe[`has${field[0].toUpperCase()}${field.slice(1)}`] = true;
        }
        return safe;
      });
    } catch (error) {
      logger.error('Cannot read the vault', { error: error.message });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ servers, vaultPath: this.store.vaultPath }));
  }



  /**
   * Create or edit a group.
   *
   * Groups come from two places: explicit lists in `.server-groups.json`, and
   * the per-server `group` field of the config. The second kind is derived at
   * read time and cannot be edited here — writing it back would duplicate into
   * a file what the config already says, and the two would drift.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #saveGroup(req, res) {
    this.#readJsonBody(req, res, payload => {
      const name = String(payload.name || '').trim();
      if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        return this.#json(res, 400, { error: 'Name must use letters, digits, dashes and underscores' });
      }
      const servers = Array.isArray(payload.servers) ? payload.servers.map(String) : [];
      const options = {
        description: payload.description ? String(payload.description) : undefined,
        strategy: payload.strategy === 'sequential' ? 'sequential' : 'parallel',
        delay: safeInteger(payload.delay, 0),
        stopOnError: Boolean(payload.stopOnError),
      };

      try {
        const existing = findGroup(name);
        // A config-derived group has no entry to update; saving one would write
        // a shadow copy that stops following the config.
        if (existing?.fromConfig && !existing.explicit) {
          return this.#json(res, 409, {
            error: `"${name}" comes from the servers' own group field. Edit it there, or pick another name.`,
          });
        }
        if (existing) updateGroup(name, { servers, ...options });
        else createGroup(name, servers, options);
        this.#broadcast({ type: 'options' });
        return this.#json(res, 200, { ok: true, name });
      } catch (error) {
        return this.#json(res, 400, { error: error.message });
      }
    });
  }

  /**
   * @param {string|null} name - Group to delete
   * @param {import('http').ServerResponse} res - Response
   */
  #deleteGroup(name, res) {
    if (!name) return this.#json(res, 400, { error: 'Which group?' });
    try {
      const existing = findGroup(name);
      if (existing?.fromConfig && !existing.explicit) {
        return this.#json(res, 409, {
          error: `"${name}" is derived from the servers' group field — remove it there instead.`,
        });
      }
      deleteGroup(name);
      this.#broadcast({ type: 'options' });
      return this.#json(res, 200, { ok: true });
    } catch (error) {
      return this.#json(res, 400, { error: error.message });
    }
  }

  /**
   * Run one command across a group.
   *
   * Answered immediately and reported on the event stream, like transfers: a
   * command across twenty machines takes as long as the slowest one, and a
   * request held open that long times out somewhere in between.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #runOnGroup(req, res) {
    this.#readJsonBody(req, res, async payload => {
      const name = String(payload.group || '');
      const command = String(payload.command || '');
      if (!command.trim()) return this.#json(res, 400, { error: 'A command is required' });

      const group = findGroup(name);
      if (!group) return this.#json(res, 404, { error: 'No such group' });

      const id = crypto.randomUUID();
      this.#json(res, 200, { id, servers: group.servers.length });

      /** @type {Record<string, any>} */
      let vault = {};
      try {
        vault = this.store.getAllDecrypted();
      } catch (error) {
        this.#broadcast({ type: 'group-run', id, state: 'failed', error: error.message });
        return;
      }

      this.#broadcast({ type: 'group-run', id, group: name, command, state: 'started', total: group.servers.length });
      let done = 0;

      await executeOnGroup(name, async serverName => {
        const config = vault[serverName];
        if (!config) throw new Error(`${serverName} is not in the vault`);
        const ssh = new SSHManager({ ...config, name: serverName });
        try {
          await ssh.connect({ readyTimeout: 15000 });
          const result = await ssh.execCommand(command, { timeout: 120000 });
          done++;
          this.#broadcast({
            type: 'group-run', id, state: 'progress', done, server: serverName,
            code: result.code, stdout: result.stdout, stderr: result.stderr,
          });
          return result;
        } finally {
          try { ssh.dispose(); } catch { /* best effort */ }
        }
      }).then(
        () => this.#broadcast({ type: 'group-run', id, state: 'done', done }),
        error => this.#broadcast({ type: 'group-run', id, state: 'failed', error: error.message })
      );
    });
  }

  /**
   * What is still living in a .env rather than in the vault.
   *
   * Offered, never performed. Somebody upgrading from 3.8 has a working setup
   * and no obligation to change it; the vault earns its place by being better,
   * not by moving their files while they are not looking. This route exists so
   * the interface can *mention* it — which is the part that was missing, since
   * nobody reads a changelog.
   *
   * @param {import('http').ServerResponse} res - Response
   */
  async #migrationState(res) {
    try {
      const loader = new ConfigLoader();
      // Deliberately without the vault: what is wanted here is what the files
      // alone hold, so a server present in both is not counted as pending.
      const loaded = await loader.load({ vaultPath: null });
      const fromFiles = loaded instanceof Map ? Object.fromEntries(loaded) : loaded;
      const inVault = new Set(this.store.exists() ? this.store.listServers() : []);

      const pending = Object.entries(fromFiles)
        .filter(([name]) => !inVault.has(name))
        .map(([name, config]) => ({
          name,
          host: config.host,
          user: config.user,
          // The count, never the values: this travels to a browser.
          secrets: SECRET_FIELDS.filter(field => config[field]).length,
          source: config.source ?? 'env',
        }));

      return this.#json(res, 200, {
        pending,
        inVault: inVault.size,
        envPath: loader.envPath ?? null,
        // A vault with no recovery file is a vault that does not survive this
        // machine, and that is exactly what the operator should know before
        // being told they can clean up their .env.
        hasVault: this.store.exists(),
      });
    } catch (error) {
      return this.#json(res, 200, { pending: [], inVault: 0, error: error.message });
    }
  }

  /**
   * Copy servers from the files into the vault. Named ones only — a button
   * that moves everything is a button somebody presses by accident.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #runMigration(req, res) {
    this.#readJsonBody(req, res, async payload => {
      const wanted = Array.isArray(payload.servers) ? payload.servers.map(String) : [];
      if (wanted.length === 0) return this.#json(res, 400, { error: 'Name the servers to import' });

      try {
        const loaded = await new ConfigLoader().load({ vaultPath: null });
        const fromFiles = loaded instanceof Map ? Object.fromEntries(loaded) : loaded;

        const imported = [];
        for (const name of wanted) {
          if (!fromFiles[name]) continue;
          this.store.setServer(name, fromFiles[name]);
          imported.push(name);
        }
        // The .env is not touched, here or anywhere: it stays the fallback, and
        // removing it is the operator's decision to make later, deliberately.
        logger.info('Servers imported from files into the vault', { count: imported.length });
        this.#broadcast({ type: 'servers' });
        return this.#json(res, 200, { imported });
      } catch (error) {
        return this.#json(res, 500, { error: error.message });
      }
    });
  }

  /**
   * Add or replace a server.
   *
   * A field left empty on an existing server keeps its stored value, so editing
   * the port does not silently wipe the password — the form cannot show it, so
   * it must not require re-typing it either.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #saveServer(req, res) {
    this.#readJsonBody(req, res, payload => {
      const name = String(payload.name || '').trim().toLowerCase();
      if (!name || !/^[a-z0-9_]+$/.test(name)) {
        return this.#json(res, 400, { error: 'Name must use letters, digits and underscores only' });
      }
      if (!payload.host) return this.#json(res, 400, { error: 'A host is required' });

      const existing = this.store.read().servers[name];
      /** @type {Record<string, any>} */
      const config = {};
      for (const [field, value] of Object.entries(payload)) {
        if (field === 'name' || value === '' || value === null || value === undefined) continue;
        config[field] = value;
      }
      // Carry forward any secret the form did not resend.
      if (existing) {
        const decrypted = this.#decryptedServer(name);
        for (const field of SECRET_FIELDS) {
          if (config[field] === undefined && decrypted?.[field] !== undefined) {
            config[field] = decrypted[field];
          }
        }
      }

      try {
        this.store.setServer(name, config);
      } catch (error) {
        return this.#json(res, 500, { error: error.message });
      }
      logger.info('Server saved from the control plane', { server: name });
      this.#broadcast({ type: 'servers' });
      return this.#json(res, 200, { ok: true, name });
    });
  }

  /**
   * One server with its secrets decrypted, keyed by name.
   *
   * Used so an edit that did not resend a password keeps the stored one: the
   * form cannot display a secret, so it must not require re-typing it.
   *
   * @param {string} name - Server name, lowercase
   * @returns {Record<string, any>|undefined} The decrypted config
   */
  #decryptedServer(name) {
    try {
      return this.store.getAllDecrypted()[name];
    } catch (error) {
      logger.error('Cannot decrypt the stored server', { server: name, error: error.message });
      return undefined;
    }
  }

  /**
   * @param {string|null} name - Server to remove
   * @param {import('http').ServerResponse} res - Response
   */
  #deleteServer(name, res) {
    if (!name) return this.#json(res, 400, { error: 'No server named' });
    const removed = this.store.removeServer(name);
    if (!removed) return this.#json(res, 404, { error: 'No such server in the vault' });
    logger.info('Server removed from the control plane', { server: name });
    this.#broadcast({ type: 'servers' });
    return this.#json(res, 200, { ok: true });
  }

  /**
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   * @param {(payload: any) => void} handler - Called with the parsed body
   */
  #readJsonBody(req, res, handler) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        handler(JSON.parse(body));
      } catch {
        this.#json(res, 400, { error: 'malformed body' });
      }
    });
  }

  /**
   * @param {import('http').ServerResponse} res - Response
   * @param {number} status - HTTP status
   * @param {any} payload - JSON body
   */
  #json(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  }


  /**
   * The control plane's interface: a built React app under `dist/ui`.
   *
   * Committed rather than built on install, for the same reason xterm.js is
   * vendored — `npm install mcp-ssh-manager` must never compile anything. If
   * the build is missing (a source checkout that has not run `npm run build:ui`)
   * this falls back to the single-file page rather than showing a blank screen.
   *
   * @param {import('http').ServerResponse} res - Response
   */
  #serveApp(res) {
    const index = path.join(APP_DIR, 'index.html');
    if (!fs.existsSync(index)) return this.#serveUi(res);
    try {
      // Vite emits root-relative asset URLs; the token has to ride along on
      // them for the same reason it does on the vendored files — a <script>
      // tag cannot authenticate itself.
      const html = fs.readFileSync(index, 'utf8')
        .replace(/(src|href)="\.?\/(app\.(?:js|css))"/g, (_, attr, file) => `${attr}="/${file}?token=${this.token}"`);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          'default-src \'none\'; style-src \'self\' \'unsafe-inline\'; '
          + 'script-src \'self\'; connect-src \'self\'; img-src \'self\' data:; font-src \'self\'',
      });
      res.end(html);
    } catch {
      this.#serveUi(res);
    }
  }

  /**
   * Static files from the build. The allowlist is by shape rather than by name
   * because the font filenames are chosen by the bundler, but the shape is
   * narrow and every path is resolved and checked to be inside APP_DIR — a
   * path from a URL is how traversal happens.
   *
   * @param {string} pathname - Requested path
   * @param {import('http').ServerResponse} res - Response
   */
  #serveAppAsset(pathname, res) {
    const types = {
      '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf',
      '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
    };
    const type = types[path.extname(pathname)];
    const resolved = path.resolve(APP_DIR, `.${pathname}`);
    if (!type || !resolved.startsWith(APP_DIR + path.sep)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
    try {
      let body = fs.readFileSync(resolved);
      // A stylesheet's url() references are fetched by the browser with no way
      // to add the token, exactly like a <script> tag. Same fix, same reason:
      // stamp it in when serving. Without this the fonts 401 and the page
      // silently falls back to the system stack.
      if (type === 'text/css') {
        body = Buffer.from(
          body.toString('utf8').replace(/url\(([^)"']*\/assets\/[^)"']+)\)/g,
            (_, asset) => `url(${asset}?token=${this.token})`)
        );
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
    }
  }

  /**
   * Open an interactive shell on a server.
   *
   * `ssh2` allocates the remote pseudo-terminal itself, so this needs no native
   * module: colours, `top`, `vim`, Ctrl-C and window resizing all work because
   * the remote side believes it is talking to a real terminal.
   *
   * Deliberately not subject to the readonly/restricted modes: those exist to
   * constrain an *agent*, and whoever holds this token is the operator who
   * configured them and already has the credentials. Constraining them here
   * would be theatre.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #openTerminal(req, res) {
    this.#readJsonBody(req, res, async payload => {
      const name = String(payload.server || '').toLowerCase();
      /** @type {Record<string, any>} */
      let servers = {};
      try {
        servers = this.store.getAllDecrypted();
      } catch (error) {
        return this.#json(res, 500, { error: `Cannot read the vault: ${error.message}` });
      }
      if (!servers[name]) return this.#json(res, 404, { error: 'No such server in the vault' });

      const id = crypto.randomUUID();
      const ssh = new SSHManager({ ...servers[name], name });

      try {
        await ssh.connect({ readyTimeout: 15000 });
        const stream = await new Promise((resolve, reject) => {
          ssh.client.shell(
            { term: 'xterm-256color', cols: payload.cols || 80, rows: payload.rows || 24 },
            (error, channel) => (error ? reject(error) : resolve(channel))
          );
        });

        const entry = { ssh, stream, server: name, subscribers: new Set(), backlog: [], backlogBytes: 0 };
        this.terminals.set(id, entry);

        const push = (channel, chunk) => {
          const payloadLine = `data: ${JSON.stringify({ channel, chunk: chunk.toString('base64') })}\n\n`;
          // Kept so a screen that attaches after the shell opened still shows
          // the login banner and the first prompt, which arrive in the gap
          // between the shell opening and the browser subscribing. Bounded, or
          // a `tail -f` left running would grow the process without limit.
          entry.backlog.push(payloadLine);
          entry.backlogBytes += payloadLine.length;
          while (entry.backlogBytes > TERMINAL_BACKLOG_BYTES && entry.backlog.length > 1) {
            entry.backlogBytes -= entry.backlog.shift().length;
          }
          for (const subscriber of entry.subscribers) {
            try { subscriber.write(payloadLine); } catch { entry.subscribers.delete(subscriber); }
          }
        };
        // Base64 because terminal output is bytes, not text: escape sequences
        // and partial UTF-8 do not survive a round trip through JSON strings.
        stream.on('data', chunk => push('stdout', chunk));
        stream.stderr?.on('data', chunk => push('stderr', chunk));
        stream.on('close', () => this.#disposeTerminal(id));

        logger.info('Interactive shell opened', { server: name });
        return this.#json(res, 200, { id, server: name });
      } catch (error) {
        try { ssh.dispose(); } catch { /* best effort */ }
        return this.#json(res, 502, { error: error.message });
      }
    });
  }

  /**
   * @param {string|null} id - Terminal id
   * @param {import('http').ServerResponse} res - Response
   */
  #streamTerminal(id, res) {
    const entry = id ? this.terminals.get(id) : null;
    if (!entry) return this.#json(res, 404, { error: 'No such terminal' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    for (const line of entry.backlog) {
      try { res.write(line); } catch { break; }
    }
    entry.subscribers.add(res);
    res.on('close', () => entry.subscribers.delete(res));
  }

  /**
   * @param {string|null} id - Terminal id
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #terminalInput(id, req, res) {
    const entry = id ? this.terminals.get(id) : null;
    if (!entry) return this.#json(res, 404, { error: 'No such terminal' });
    this.#readJsonBody(req, res, payload => {
      try {
        entry.stream.write(Buffer.from(String(payload.data || ''), 'base64'));
        return this.#json(res, 200, { ok: true });
      } catch (error) {
        return this.#json(res, 500, { error: error.message });
      }
    });
  }

  /**
   * @param {string|null} id - Terminal id
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #terminalResize(id, req, res) {
    const entry = id ? this.terminals.get(id) : null;
    if (!entry) return this.#json(res, 404, { error: 'No such terminal' });
    this.#readJsonBody(req, res, payload => {
      try {
        // Without this, a full-screen program draws for the wrong window size
        // and the display is garbled the moment anyone resizes.
        entry.stream.setWindow(payload.rows || 24, payload.cols || 80, 0, 0);
        return this.#json(res, 200, { ok: true });
      } catch (error) {
        return this.#json(res, 500, { error: error.message });
      }
    });
  }

  /**
   * @param {string|null} id - Terminal id
   * @param {import('http').ServerResponse} res - Response
   */
  #closeTerminal(id, res) {
    if (!id || !this.terminals.has(id)) return this.#json(res, 404, { error: 'No such terminal' });
    this.#disposeTerminal(id);
    return this.#json(res, 200, { ok: true });
  }

  /**
   * Close a shell and release its SSH connection.
   * @param {string} id - Terminal id
   */
  #disposeTerminal(id) {
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.terminals.delete(id);
    for (const subscriber of entry.subscribers) {
      try { subscriber.end(); } catch { /* already gone */ }
    }
    try { entry.stream.end(); } catch { /* already closed */ }
    try { entry.ssh.dispose(); } catch { /* best effort */ }
    logger.info('Interactive shell closed', { server: entry.server });
  }





  /**
   * Move files between this machine and a server, in either direction.
   *
   * Done here rather than by the browser downloading and re-uploading: the
   * bytes never leave this process, which is both faster and the only way a
   * multi-gigabyte file works at all. Progress is reported on the event stream
   * so the page can show it without polling.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #transfer(req, res) {
    this.#readJsonBody(req, res, async payload => {
      const name = String(payload.server || '').toLowerCase();
      const direction = payload.direction === 'download' ? 'download' : 'upload';
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) return this.#json(res, 400, { error: 'Nothing to transfer' });

      const id = crypto.randomUUID();
      // Answered immediately: a transfer can take minutes, and a request left
      // open that long is a request that times out somewhere in between.
      this.#json(res, 200, { id, count: items.length });

      let done = 0;
      const announce = (extra = {}) =>
        this.#broadcast({ type: 'transfer', id, direction, server: name, done, total: items.length, ...extra });
      announce({ state: 'started' });

      try {
        await this.#withSftp(name, async sftp => {
          for (const item of items) {
            const local = path.resolve(String(item.local));
            const remote = String(item.remote);
            await new Promise((resolve, reject) => {
              const from = direction === 'upload' ? fs.createReadStream(local) : sftp.createReadStream(remote);
              const to = direction === 'upload' ? sftp.createWriteStream(remote) : fs.createWriteStream(local);
              from.on('error', reject);
              to.on('error', reject);
              to.on('close', resolve);
              to.on('finish', resolve);
              from.pipe(to);
            });
            done++;
            announce({ state: 'progress', file: path.basename(local) });
          }
        });
        announce({ state: 'done' });
        logger.info('Transfer finished', { server: name, direction, count: items.length });
      } catch (error) {
        announce({ state: 'failed', error: error.message });
        logger.warn('Transfer failed', { server: name, direction, error: error.message });
      }
    });
  }

  /**
   * List a directory on this machine.
   *
   * No path restriction, deliberately and for the same reason as the terminal:
   * whoever holds this token already has a shell here. A sandbox that a shell
   * sits next to is decoration.
   *
   * @param {URLSearchParams} params - Query
   * @param {import('http').ServerResponse} res - Response
   */
  #listLocal(params, res) {
    const dir = params.get('path') || os.homedir();
    try {
      const resolved = path.resolve(dir);
      const entries = fs.readdirSync(resolved, { withFileTypes: true }).map(entry => {
        const full = path.join(resolved, entry.name);
        let stat;
        try {
          // lstat, not stat: a symlink must report as one rather than as
          // whatever it points at, and a broken link must not throw.
          stat = fs.lstatSync(full);
        } catch {
          stat = null;
        }
        return {
          name: entry.name,
          path: full,
          size: stat?.size ?? 0,
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink(),
          modifyTime: stat?.mtimeMs ?? 0,
          accessTime: stat?.atimeMs ?? 0,
          permissions: stat ? stat.mode & 0o7777 : 0,
          owner: stat?.uid ?? 0,
          group: stat?.gid ?? 0,
        };
      });
      return this.#json(res, 200, { path: resolved, entries, home: os.homedir(), separator: path.sep });
    } catch (error) {
      return this.#json(res, error.code === 'ENOENT' ? 404 : 403, { error: error.message });
    }
  }

  /**
   * Stream a local file out, so the remote pane can upload it without the
   * browser ever holding the bytes.
   *
   * @param {URLSearchParams} params - Query
   * @param {import('http').ServerResponse} res - Response
   */
  #readLocal(params, res) {
    const file = params.get('path') || '';
    try {
      const resolved = path.resolve(file);
      const stream = fs.createReadStream(resolved);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${path.basename(resolved).replace(/["\r\n]/g, '_')}"`,
      });
      stream.on('error', () => res.end());
      stream.pipe(res);
    } catch (error) {
      return this.#json(res, 404, { error: error.message });
    }
  }

  /**
   * mkdir / rename / delete / reveal on this machine.
   *
   * @param {'mkdir'|'rename'|'delete'|'reveal'} kind - Which operation
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #localOp(kind, req, res) {
    this.#readJsonBody(req, res, payload => {
      try {
        if (kind === 'mkdir') fs.mkdirSync(path.resolve(String(payload.path)), { recursive: true });
        else if (kind === 'rename') fs.renameSync(path.resolve(String(payload.from)), path.resolve(String(payload.to)));
        else if (kind === 'delete') fs.rmSync(path.resolve(String(payload.path)), { recursive: Boolean(payload.isDirectory), force: false });
        else if (kind === 'reveal') {
          // execFile, never a shell: a path is not ours to trust even when it
          // came from our own listing, and this one round-trips through a
          // browser on the way.
          const opener = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'explorer' : 'xdg-open';
          execFile(opener, [path.resolve(String(payload.path))], () => { /* best effort */ });
        }
        logger.info(`Local ${kind}`, { path: payload.path ?? payload.to });
        return this.#json(res, 200, { ok: true });
      } catch (error) {
        return this.#json(res, 400, { error: error.message });
      }
    });
  }

  /**
   * Run one command on a server and hand back what it printed.
   *
   * Same reasoning as the terminal and the file routes: this is the operator's
   * own hands, not an agent's, so the readonly/restricted modes do not apply.
   * It exists because a file browser needs `chmod` and `chown`, and because
   * "run this on that machine" is the shortest path between a screen and an
   * answer.
   *
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #execute(req, res) {
    this.#readJsonBody(req, res, async payload => {
      const name = String(payload.server || '').toLowerCase();
      const command = String(payload.command || '');
      if (!command.trim()) return this.#json(res, 400, { error: 'A command is required' });

      /** @type {Record<string, any>} */
      let servers = {};
      try {
        servers = this.store.getAllDecrypted();
      } catch (error) {
        return this.#json(res, 500, { error: `Cannot read the vault: ${error.message}` });
      }
      if (!servers[name]) return this.#json(res, 404, { error: 'No such server in the vault' });

      const ssh = new SSHManager({ ...servers[name], name });
      try {
        await ssh.connect({ readyTimeout: 15000 });
        const result = await ssh.execCommand(command, { timeout: 60000 });
        logger.info('Command run from the control plane', { server: name });
        return this.#json(res, 200, { stdout: result.stdout, stderr: result.stderr, code: result.code });
      } catch (error) {
        return this.#json(res, 502, { error: error.message });
      } finally {
        try { ssh.dispose(); } catch { /* best effort */ }
      }
    });
  }

  /**
   * Borrow a live SFTP session for a server, opening one if needed.
   *
   * The idle timer restarts on every use, so an operator browsing a tree keeps
   * one connection and someone who wandered off keeps none.
   *
   * @param {string} name - Server name, already lowercased
   * @returns {Promise<any>} an ssh2 SFTP session
   */
  async #sftp(name) {
    const existing = this.sftpPool.get(name);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.#releaseSftp(name), SFTP_IDLE_MS);
      return existing.sftp;
    }

    /** @type {Record<string, any>} */
    const servers = this.store.getAllDecrypted();
    if (!servers[name]) throw Object.assign(new Error('No such server in the vault'), { status: 404 });

    const ssh = new SSHManager({ ...servers[name], name });
    await ssh.connect({ readyTimeout: 15000 });
    const sftp = await ssh.getSFTP();
    const entry = { ssh, sftp, timer: setTimeout(() => this.#releaseSftp(name), SFTP_IDLE_MS) };
    this.sftpPool.set(name, entry);
    logger.info('SFTP session opened', { server: name });
    return sftp;
  }

  /** @param {string} name - Server name */
  #releaseSftp(name) {
    const entry = this.sftpPool.get(name);
    if (!entry) return;
    this.sftpPool.delete(name);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.ssh.dispose(); } catch { /* best effort */ }
    logger.info('SFTP session released', { server: name });
  }

  /**
   * Turn an SFTP callback into a promise, and a dropped connection into a
   * retry. A pooled session can die between two requests — the machine
   * rebooted, the network moved — and the operator should not have to know
   * that; they clicked a folder.
   *
   * @param {string} name - Server name
   * @param {(sftp: any) => Promise<any>} run - What to do with the session
   */
  async #withSftp(name, run) {
    try {
      return await withTimeout(run(await this.#sftp(name)));
    } catch (error) {
      if (/** @type {any} */ (error).status === 404) throw error;
      this.#releaseSftp(name);
      return withTimeout(run(await this.#sftp(name)));
    }
  }

  /**
   * List a directory. Returns the shape a file browser wants — one stat per
   * entry, already merged — because a browser that has to stat every row makes
   * one round trip per file.
   *
   * @param {URLSearchParams} params - Query
   * @param {import('http').ServerResponse} res - Response
   */
  async #listFiles(params, res) {
    const name = String(params.get('server') || '').toLowerCase();
    const requested = params.get('path') || '.';
    try {
      const result = await this.#withSftp(name, async sftp => {
        // '.' means the home directory, and the browser needs its real name:
        // without resolving it the breadcrumb has nothing to show, and every
        // path built from there is relative to a directory it cannot name.
        const dir = requested === '.' ? await realpath(sftp, '.') : requested;
        const list = await readdir(sftp, dir);
        return { dir, entries: list.map(item => describe(dir, item)) };
      });
      return this.#json(res, 200, { path: result.dir, entries: result.entries });
    } catch (error) {
      return this.#json(res, /** @type {any} */ (error).status || 502, { error: error.message });
    }
  }

  /**
   * Stream a file down. Streamed rather than buffered: a control plane that
   * reads a 4 GB log into memory to hand it over is a control plane that dies.
   *
   * @param {URLSearchParams} params - Query
   * @param {import('http').ServerResponse} res - Response
   */
  async #readFile(params, res) {
    const name = String(params.get('server') || '').toLowerCase();
    const file = params.get('path') || '';
    try {
      const sftp = await this.#sftp(name);
      const stream = sftp.createReadStream(file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        // The name is quoted and stripped of quotes and control characters: a
        // filename is remote input, and this header is parsed by the browser.
        'content-disposition': `attachment; filename="${String(file.split('/').pop()).replace(/[""\r\n]/g, '_')}"`,
      });
      stream.on('error', (/** @type {Error} */ error) => {
        logger.warn('File read failed', { server: name, error: error.message });
        res.end();
      });
      stream.pipe(res);
    } catch (error) {
      return this.#json(res, /** @type {any} */ (error).status || 502, { error: error.message });
    }
  }

  /**
   * Stream a file up.
   * @param {URLSearchParams} params - Query
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  async #writeFile(params, req, res) {
    const name = String(params.get('server') || '').toLowerCase();
    const file = params.get('path') || '';
    try {
      const sftp = await this.#sftp(name);
      await new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(file);
        stream.on('close', resolve);
        stream.on('error', reject);
        req.on('error', reject);
        req.pipe(stream);
      });
      logger.info('File written', { server: name, path: file });
      return this.#json(res, 200, { ok: true });
    } catch (error) {
      return this.#json(res, /** @type {any} */ (error).status || 502, { error: error.message });
    }
  }

  /**
   * mkdir / rename / delete. One handler because they differ only in the call.
   *
   * @param {'mkdir'|'rename'|'delete'} kind - Which operation
   * @param {import('http').IncomingMessage} req - Request
   * @param {import('http').ServerResponse} res - Response
   */
  #fileOp(kind, req, res) {
    this.#readJsonBody(req, res, async payload => {
      const name = String(payload.server || '').toLowerCase();
      try {
        await this.#withSftp(name, sftp => new Promise((resolve, reject) => {
          const done = (/** @type {Error|null} */ error) => (error ? reject(error) : resolve(true));
          if (kind === 'mkdir') return sftp.mkdir(String(payload.path), done);
          if (kind === 'rename') return sftp.rename(String(payload.from), String(payload.to), done);
          // rmdir and unlink are different calls, and the caller knows which it
          // clicked on — asking SFTP to guess would mean a stat per delete.
          return payload.isDirectory
            ? sftp.rmdir(String(payload.path), done)
            : sftp.unlink(String(payload.path), done);
        }));
        logger.info(`File ${kind}`, { server: name });
        return this.#json(res, 200, { ok: true });
      } catch (error) {
        return this.#json(res, /** @type {any} */ (error).status || 502, { error: error.message });
      }
    });
  }

  /**
   * Groups and known host keys — the two pieces of state that live in files and
   * are therefore readable from here.
   *
   * Tunnels are deliberately absent: tunnel-manager keeps them in a Map inside
   * the MCP server's process, so this process cannot see them. Showing an empty
   * or stale tunnel list would be worse than showing none.
   *
   * @param {import('http').ServerResponse} res - Response
   */
  #serveOptions(res) {
    /** @type {any[]} */
    let groups = [];
    try {
      groups = listGroups();
    } catch (error) {
      logger.warn('Cannot list groups', { error: error.message });
    }

    /** @type {any[]} */
    let hostKeys = [];
    try {
      hostKeys = listKnownHosts();
    } catch (error) {
      logger.warn('Cannot read known_hosts', { error: error.message });
    }

    // Tunnels are opened inside the MCP server's process; it publishes them to
    // a file so this one can show them. `stale` means the file was written by a
    // process that is no longer running — showing those as open would be a lie.
    const tunnelState = readPublishedTunnels();

    this.#json(res, 200, { groups, hostKeys, tunnels: tunnelState.tunnels, tunnelsStale: tunnelState.stale });
  }

  /**
   * Forget a host key.
   *
   * The reason this belongs in a control plane: when a server is rebuilt its
   * host key changes, every connection then fails with a warning, and the fix
   * is to remove the stale entry. Doing that by hand means editing
   * ~/.ssh/known_hosts with a line number from an error message.
   *
   * @param {string|null} host - Host to forget
   * @param {string|null} port - Port, defaults to 22
   * @param {import('http').ServerResponse} res - Response
   */
  #forgetHostKey(host, port, res) {
    if (!host) return this.#json(res, 400, { error: 'No host named' });
    try {
      const removed = removeHostKey(host, Number(port) || 22);
      if (!removed) return this.#json(res, 404, { error: 'No such host key' });
      logger.info('Host key forgotten from the control plane', { host, port });
      this.#broadcast({ type: 'options' });
      return this.#json(res, 200, { ok: true });
    } catch (error) {
      return this.#json(res, 500, { error: error.message });
    }
  }

  /**
   * Probe one server's health, or every server when no name is given.
   *
   * The control plane opens its own SSH connection for this: it holds the
   * vault, so it has the credentials, and the MCP server is driven by an agent
   * rather than by us. Connections are opened per probe and closed straight
   * after — a dashboard that quietly holds a connection open to every machine
   * is a dashboard nobody should run.
   *
   * Only ever on request. Nothing is polled in the background: each probe costs
   * an SSH handshake, and a control plane that connects to every production box
   * on a timer would be worse than no dashboard at all.
   *
   * @param {string|null} name - Server to probe, or null for all
   * @param {import('http').ServerResponse} res - Response
   */
  async #probeHealth(name, res) {
    /** @type {Record<string, any>} */
    let servers = {};
    try {
      servers = this.store.getAllDecrypted();
    } catch (error) {
      return this.#json(res, 500, { error: `Cannot read the vault: ${error.message}` });
    }

    const targets = name ? [name.toLowerCase()].filter(n => servers[n]) : Object.keys(servers);
    if (targets.length === 0) {
      return this.#json(res, 200, { results: [] });
    }

    // In parallel: one slow or unreachable machine must not delay the others.
    const results = await Promise.all(targets.map(async serverName => {
      const config = { ...servers[serverName], name: serverName };
      const started = Date.now();
      const ssh = new SSHManager(config);
      try {
        // Short, because this is a dashboard: a machine that has not answered
        // in eight seconds is "unreachable" as far as the screen is concerned,
        // and the operator would rather see that than watch a spinner.
        await ssh.connect({ readyTimeout: 8000 });
        const result = await ssh.execCommand(buildComprehensiveHealthCheckCommand(), { timeout: 20000 });
        const health = parseComprehensiveHealthCheck(result.stdout);
        return { server: serverName, host: config.host, reachable: true, tookMs: Date.now() - started, ...health };
      } catch (error) {
        // Unreachable is a legitimate answer, not an error: it is exactly what
        // the operator wants to see on the screen.
        return {
          server: serverName,
          host: config.host,
          reachable: false,
          tookMs: Date.now() - started,
          error: error.message,
        };
      } finally {
        try { ssh.dispose(); } catch { /* best effort */ }
      }
    }));

    this.#broadcast({ type: 'health', results });
    return this.#json(res, 200, { results });
  }

  /**
   * Follow the audit logs so the timeline shows what happened without approval
   * too — the engine writes them whether or not anyone is watching.
   */
  #startAuditTail() {
    if (this.auditPaths.length === 0) return;

    const readNew = () => {
      for (const auditPath of this.auditPaths) {
        try {
          const { size } = fs.statSync(auditPath);
          // First sight of this file: start at its end, so opening the control
          // plane does not replay months of history. Record the offset even when
          // there is nothing to read — otherwise an empty log is treated as
          // "unseen" forever and every later line is skipped as history.
          if (!this.auditOffsets.has(auditPath)) {
            this.auditOffsets.set(auditPath, size);
            continue;
          }
          const from = /** @type {number} */ (this.auditOffsets.get(auditPath));
          if (size <= from) {
            // Truncated or rotated: start over rather than reading garbage.
            if (size < from) this.auditOffsets.set(auditPath, 0);
            continue;
          }
          const fd = fs.openSync(auditPath, 'r');
          const buffer = Buffer.alloc(size - from);
          fs.readSync(fd, buffer, 0, buffer.length, from);
          fs.closeSync(fd);
          this.auditOffsets.set(auditPath, size);

          for (const line of buffer.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
              this.#record({ ...JSON.parse(line), source: 'audit' });
            } catch { /* partial line, it will come round again */ }
          }
        } catch { /* file not created yet */ }
      }
    };

    readNew();
    this.auditTimer = setInterval(readNew, 1000);
    this.auditTimer.unref?.();
  }

  /** @param {Object} entry - Timeline entry */
  #record(entry) {
    this.timeline.push(entry);
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.shift();
    this.#broadcast({ type: 'timeline', entry });
  }

  /** @param {Object} event - Event to push to every open page */
  #broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const response of this.subscribers) {
      try { response.write(payload); } catch { this.subscribers.delete(response); }
    }
  }
}
