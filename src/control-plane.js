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
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { SecretStore, defaultVaultPath, SECRET_FIELDS } from './secret-store.js';
import { StreamRegistry, listenForStreams, streamSocketPath } from './live-stream.js';
import SSHManager from './ssh-manager.js';
import { buildComprehensiveHealthCheckCommand, parseComprehensiveHealthCheck } from './health-monitor.js';

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
    return `http://127.0.0.1:${address.port}/?token=${this.token}`;
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

    if (req.method === 'GET' && url.pathname === '/') return this.#serveUi(res);
    if (req.method === 'GET' && url.pathname === '/api/state') return this.#serveState(res);
    if (req.method === 'GET' && url.pathname === '/api/events') return this.#serveEvents(res);
    if (req.method === 'POST' && url.pathname === '/api/decide') return this.#handleDecision(req, res);
    if (req.method === 'POST' && url.pathname === '/api/health') {
      return this.#probeHealth(url.searchParams.get('name'), res);
    }
    if (req.method === 'GET' && url.pathname === '/api/streams') {
      const id = url.searchParams.get('id');
      return this.#json(res, 200, id ? { stream: this.streams.get(id) } : { streams: this.streams.list() });
    }
    if (req.method === 'GET' && url.pathname === '/api/servers') return this.#serveServers(res);
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

  /** @param {import('http').ServerResponse} res - Response */
  #serveUi(res) {
    const html = fs.readFileSync(path.join(__dirname, 'control-plane-ui.html'), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // This page holds a token that approves root commands: never cached, and
      // no resource may be loaded from anywhere else.
      'cache-control': 'no-store',
      'content-security-policy':
        'default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'self\'',
    });
    res.end(html);
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
