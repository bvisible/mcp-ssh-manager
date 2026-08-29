// Live command streaming — watching over the agent's shoulder.
//
// When a control plane is listening, the engine mirrors what it runs to it as
// it runs: the command, then its output, then the exit code. That is the one
// thing no CLI can offer and the reason to have a window at all — seeing what
// an agent is doing on a production box at the second it happens, rather than
// reading about it afterwards.
//
// The scrollback idea (a bounded circular buffer per stream, so a page opened
// late still shows recent context) is lifted from TransHub's PtyService —
// same author, relicensed here under MIT along with the rest of the engine.
//
// ## Two rules this module must never break
//
//   1. **It cannot slow a command down.** Every send is fire-and-forget over a
//      datagram-style write; nothing here is awaited on the execution path, and
//      a missing or wedged control plane costs one failed connect attempt.
//   2. **It is off unless someone is watching.** No socket, no work: not even
//      the buffers are allocated.

import net from 'net';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { defaultSocketPath } from './approval.js';

/** Bytes of recent output kept per stream, so a late viewer sees context. */
const SCROLLBACK_BYTES = 64 * 1024;

/** Suffix of the streaming socket, next to the approval one. */
const STREAM_SOCKET_SUFFIX = '.stream';

/**
 * Where the control plane listens for stream events.
 *
 * A second socket rather than reusing the approval one: approval is a
 * request/response that blocks a command, streaming is a one-way firehose. On
 * one socket a slow reader of the firehose would delay a decision.
 *
 * @returns {string} Socket path
 */
export function streamSocketPath() {
  return `${defaultSocketPath()}${STREAM_SOCKET_SUFFIX}`;
}

/**
 * Is anyone watching?
 *
 * Checked per command rather than cached: the window can be opened and closed
 * at any time, and a stale "yes" would mean a connect attempt per command with
 * nothing on the other end.
 *
 * @returns {boolean} True when a control plane is listening for streams
 */
export function isWatching() {
  if (process.platform === 'win32') return true;
  try {
    return fs.statSync(streamSocketPath()).isSocket();
  } catch {
    return false;
  }
}

/**
 * A single command being mirrored to the control plane.
 *
 * Holds one connection for the life of the command. Output arrives in chunks
 * from ssh2 and is forwarded as it comes.
 */
class LiveStream {
  /**
   * @param {string} server - Server name
   * @param {string} command - The command being run, as sent to the host
   */
  constructor(server, command) {
    this.id = crypto.randomUUID();
    this.server = server;
    this.command = command;
    /** @type {import('net').Socket|null} */
    this.socket = null;
    this.closed = false;

    try {
      this.socket = net.createConnection(streamSocketPath());
      // Errors here are expected and uninteresting: the window was closed, the
      // socket went away. Streaming is a convenience, never a dependency.
      this.socket.on('error', () => { this.closed = true; });
      this.#send({ type: 'start', command, ts: new Date().toISOString() });
    } catch {
      this.closed = true;
    }
  }

  /**
   * @param {Record<string, any>} event - Event payload
   */
  #send(event) {
    if (this.closed || !this.socket) return;
    try {
      this.socket.write(`${JSON.stringify({ id: this.id, server: this.server, ...event })}\n`);
    } catch {
      this.closed = true;
    }
  }

  /**
   * Forward a chunk of output.
   * @param {string} channel - 'stdout' or 'stderr'
   * @param {string} chunk - The bytes, as text
   */
  write(channel, chunk) {
    if (!chunk) return;
    this.#send({ type: 'data', channel, chunk });
  }

  /**
   * Close the stream and report how the command ended.
   * @param {number|null} code - Exit code
   */
  end(code) {
    this.#send({ type: 'end', code, ts: new Date().toISOString() });
    try { this.socket?.end(); } catch { /* already gone */ }
    this.closed = true;
  }
}

/**
 * Open a stream for a command, or return null when nobody is watching.
 *
 * Callers do not need to branch: `stream?.write(...)` and `stream?.end(...)`
 * are no-ops when this returns null.
 *
 * @param {string} server - Server name
 * @param {string} command - Command being run
 * @returns {LiveStream|null} The stream, or null when there is no viewer
 */
export function openStream(server, command) {
  if (!isWatching()) return null;
  return new LiveStream(server, command);
}

/**
 * Server side: keeps recent output per stream so a page opened mid-command
 * shows what came before, not just what follows.
 */
export class StreamRegistry {
  constructor() {
    /** @type {Map<string, {id: string, server: string, command: string, startedAt: string, scrollback: string, code: number|null}>} */
    this.streams = new Map();
    /** @type {Set<(event: any) => void>} */
    this.listeners = new Set();
  }

  /**
   * @param {(event: any) => void} listener - Called for every event
   * @returns {() => void} Unsubscribe
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply one event from the engine.
   * @param {any} event - Parsed event
   */
  apply(event) {
    if (event.type === 'start') {
      this.streams.set(event.id, {
        id: event.id,
        server: event.server,
        command: event.command,
        startedAt: event.ts,
        scrollback: '',
        code: null,
      });
    } else if (event.type === 'data') {
      const stream = this.streams.get(event.id);
      if (stream) {
        stream.scrollback += event.chunk;
        // Bounded, so a command that prints for an hour cannot grow without
        // limit. Trimming from the front keeps the most recent output.
        if (stream.scrollback.length > SCROLLBACK_BYTES) {
          stream.scrollback = stream.scrollback.slice(-SCROLLBACK_BYTES);
        }
      }
    } else if (event.type === 'end') {
      const stream = this.streams.get(event.id);
      if (stream) stream.code = event.code;
      // Finished streams are kept: the interesting one to read is usually the
      // one that just ended. Trim the oldest so memory stays bounded.
      this.#trimFinished();
    }

    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a dead subscriber must not stop others */ }
    }
  }

  /** Keep at most 20 finished streams, oldest dropped first. */
  #trimFinished() {
    const finished = [...this.streams.values()].filter(s => s.code !== null);
    if (finished.length <= 20) return;
    for (const stream of finished.slice(0, finished.length - 20)) {
      this.streams.delete(stream.id);
    }
  }

  /** @returns {any[]} Streams, most recent first */
  list() {
    return [...this.streams.values()].reverse();
  }

  /**
   * @param {string} id - Stream id
   * @returns {any|undefined} One stream with its scrollback
   */
  get(id) {
    return this.streams.get(id);
  }
}

/**
 * Listen for stream events from the engine.
 *
 * @param {StreamRegistry} registry - Where events are applied
 * @param {string} [socketPath] - Socket to create
 * @returns {Promise<import('net').Server>} The listening server
 */
export function listenForStreams(registry, socketPath = streamSocketPath()) {
  try {
    if (fs.statSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch { /* nothing there */ }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      // Chunks arrive split at arbitrary points; only complete lines are events.
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          registry.apply(JSON.parse(line));
        } catch { /* partial or malformed: drop the line, keep the stream */ }
      }
    });
    socket.on('error', () => { /* engine went away mid-command */ });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
      resolve(server);
    });
  });
}
