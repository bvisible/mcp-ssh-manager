/**
 * The SSH Manager adapter.
 *
 * TransHub's components never talk to Electron directly — they call
 * `window.api.*`, which Electron fills with IPC and the relay fills with
 * WebSocket RPC. This is the third filling: plain HTTP and SSE against the
 * control plane running on localhost.
 *
 * That indirection is the whole reason this port is small. Nothing below
 * changes a component; it changes what the components were already calling.
 *
 * Two shapes differ from Electron and are worth stating:
 *
 *   - **The token.** Every request carries it. Electron had a process boundary
 *     for authority; a page on localhost has a token, and a page without one is
 *     refused rather than trusted for being local.
 *   - **Events.** Electron pushes over IPC and returns an unsubscribe. Here the
 *     push is Server-Sent Events, and the same unsubscribe contract is kept so
 *     callers do not care which it is.
 */

const token = new URLSearchParams(window.location.search).get('token') ?? '';

/** Callers pass paths and names that may contain anything a filesystem allows. */
function url(path: string, params: Record<string, string | number | undefined> = {}): string {
  const query = new URLSearchParams({ token });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `${path}?${query}`;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const response = await fetch(url(path, params));
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return response.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown, params?: Record<string, string | number | undefined>): Promise<T> {
  const response = await fetch(url(path, params), {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types — the shapes the components already expect
// ---------------------------------------------------------------------------

export interface ServerAccount {
  id: string;
  label: string;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  isDefault?: boolean;
  metadata?: { hasSudo?: boolean; isRoot?: boolean; description?: string };
}

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  defaultDirectory?: string;
  category?: string;
  accounts?: ServerAccount[];
  /** SSH Manager additions, absent from TransHub's model. */
  mode?: 'unrestricted' | 'readonly' | 'restricted';
  approval?: 'never' | 'destructive' | 'always';
}

export interface RemoteFileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  modifyTime: number;
  accessTime: number;
  permissions: number;
  owner: number;
  group: number;
}

/** What the vault hands back, before it is shaped into a ServerConfig. */
interface VaultServer {
  name: string;
  host: string;
  port?: number;
  user?: string;
  hasPassword?: boolean;
  keyPath?: string;
  defaultDir?: string;
  group?: string;
  mode?: ServerConfig['mode'];
  approval?: ServerConfig['approval'];
  accounts?: ServerAccount[];
}

// ---------------------------------------------------------------------------
// Servers — the encrypted vault behind the same calls
// ---------------------------------------------------------------------------

/**
 * The vault speaks the engine's vocabulary (`user`, `keyPath`, `defaultDir`);
 * the components speak TransHub's (`username`, `privateKey`, `defaultDirectory`).
 * Translating here rather than renaming either side keeps the engine's config
 * format — which is published, documented and depended on — untouched.
 */
function toServerConfig(server: VaultServer): ServerConfig {
  return {
    id: server.name,
    name: server.name,
    host: server.host,
    port: server.port ?? 22,
    username: server.user ?? '',
    privateKey: server.keyPath,
    defaultDirectory: server.defaultDir,
    category: server.group,
    mode: server.mode,
    approval: server.approval,
    accounts: server.accounts,
  };
}

export const servers = {
  async list(): Promise<ServerConfig[]> {
    const data = await get<{ servers: VaultServer[] }>('/api/servers');
    return data.servers.map(toServerConfig);
  },

  async save(config: ServerConfig): Promise<void> {
    await post('/api/servers', {
      name: config.name,
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      keyPath: config.privateKey,
      passphrase: config.passphrase,
      defaultDir: config.defaultDirectory,
      group: config.category,
      mode: config.mode,
      approval: config.approval,
      accounts: config.accounts,
    });
  },

  async remove(name: string): Promise<void> {
    const response = await fetch(url('/api/servers', { name }), { method: 'DELETE' });
    if (!response.ok) throw new Error(response.statusText);
  },
};


// ---------------------------------------------------------------------------
// Migration from files
// ---------------------------------------------------------------------------

export interface PendingServer {
  name: string;
  host: string;
  user?: string;
  /** How many secrets it holds — never which, or their values. */
  secrets: number;
  source: 'env' | 'toml';
}

export const migration = {
  state: () => get<{
    pending: PendingServer[];
    inVault: number;
    envPath: string | null;
    hasVault: boolean;
  }>('/api/migration'),

  /** Named servers only. A button that moves everything gets pressed by accident. */
  run: (servers: string[]) => post<{ imported: string[] }>('/api/migration', { servers }),
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const files = {
  list: (server: string, path: string) =>
    get<{ path: string; entries: RemoteFileInfo[] }>('/api/files', { server, path }),

  mkdir: (server: string, path: string) => post('/api/files/mkdir', { server, path }),

  rename: (server: string, from: string, to: string) => post('/api/files/rename', { server, from, to }),

  remove: (server: string, path: string, isDirectory: boolean) =>
    post('/api/files/delete', { server, path, isDirectory }),

  /** A URL rather than bytes: let the browser stream the download itself. */
  downloadUrl: (server: string, path: string) => url('/api/files/read', { server, path }),

  async upload(server: string, path: string, file: Blob): Promise<void> {
    const response = await fetch(url('/api/files/write', { server, path }), { method: 'POST', body: file });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  },
};


// ---------------------------------------------------------------------------
// This machine
// ---------------------------------------------------------------------------

/**
 * The control plane runs on the operator's own machine, so it can read that
 * machine's disk — which is what makes a local/remote pair possible. A page in
 * a browser could not; the page is not what reads it.
 */
export const local = {
  list: (path?: string) =>
    get<{ path: string; entries: RemoteFileInfo[]; home: string; separator: string }>(
      '/api/local/files', { path }),

  mkdir: (path: string) => post('/api/local/mkdir', { path }),

  rename: (from: string, to: string) => post('/api/local/rename', { from, to }),

  remove: (path: string, isDirectory: boolean) => post('/api/local/delete', { path, isDirectory }),

  /** Open the enclosing folder in Finder / Explorer / the desktop's file manager. */
  reveal: (path: string) => post('/api/local/reveal', { path }),
};

export interface TransferEvent {
  type: 'transfer';
  id: string;
  direction: 'upload' | 'download';
  server: string;
  done: number;
  total: number;
  state: 'started' | 'progress' | 'done' | 'failed';
  file?: string;
  error?: string;
}

export const transfers = {
  /**
   * Move files between the two panes. The bytes go directly between this
   * machine and the server through the control plane — the browser never holds
   * them, which is both faster and the only way a large file works at all.
   */
  start: (request: {
    server: string;
    direction: 'upload' | 'download';
    items: { local: string; remote: string }[];
  }) => post<{ id: string; count: number }>('/api/transfer', request),
};

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

export interface ShellHandle {
  id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: Uint8Array) => void): () => void;
  onExit(handler: () => void): void;
  close(): Promise<void>;
}

const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export const shells = {
  async open(server: string, cols: number, rows: number): Promise<ShellHandle> {
    const { id } = await post<{ id: string }>('/api/terminal', { server, cols, rows });
    const source = new EventSource(url('/api/terminal/stream', { id }));
    let onExit: (() => void) | null = null;

    // Errors on an EventSource are also how it reports the stream ending, and a
    // closed shell is not a failure — it is the user typing `exit`.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) onExit?.();
    };

    return {
      id,
      write: data => {
        void fetch(url('/api/terminal/input', { id }), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: toBase64(encoder.encode(data)) }),
        });
      },
      resize: (nextCols, nextRows) => {
        void fetch(url('/api/terminal/resize', { id }), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols: nextCols, rows: nextRows }),
        });
      },
      onData: handler => {
        // Bytes, not text: the terminal stream carries escape sequences and
        // UTF-8 that can be split across two events, so decoding is the
        // emulator's job, not ours.
        const listener = (event: MessageEvent) => handler(fromBase64(JSON.parse(event.data).chunk));
        source.addEventListener('message', listener);
        return () => source.removeEventListener('message', listener);
      },
      onExit: handler => { onExit = handler; },
      close: async () => {
        source.close();
        await fetch(url('/api/terminal', { id }), { method: 'DELETE' });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Commands, health, and what the agents are doing
// ---------------------------------------------------------------------------

export const ssh = {
  execute: (server: string, command: string) =>
    post<{ stdout: string; stderr: string; code: number }>('/api/execute', { server, command }),
};

export interface HealthResult {
  server: string;
  host: string;
  reachable: boolean;
  tookMs: number;
  error?: string;
  /** The engine's own shape — snake_case in places, and `disks`, not `disk`. */
  cpu?: { percent?: number; usage?: string; status?: string };
  memory?: { total_mb?: number; used_mb?: number; free_mb?: number; percent?: number; status?: string };
  disks?: { mount: string; size: string; used: string; avail: string; percent: number; status?: string }[];
  load_average?: string;
  /** Already reads "up 42 days" — prefixing it again is how you get "up up". */
  uptime?: string;
  overall_status?: 'healthy' | 'warning' | 'critical';
}

export const health = {
  /**
   * Probed on demand, never on a timer: every probe is an SSH handshake, and a
   * dashboard that connects to every production box on a schedule is worse
   * than no dashboard.
   *
   * The server name goes in the query rather than the body — that is what the
   * route reads, and sending it in the body silently probed everything.
   */
  check: (server?: string) => post<{ results: HealthResult[] }>('/api/health', undefined, { name: server }),
};

export interface ApprovalRequest {
  id: string;
  ts: string;
  server: string;
  host: string;
  user: string;
  mode: 'unrestricted' | 'readonly' | 'restricted';
  tool: string;
  command?: string;
  destructive: boolean;
}

/**
 * What the queue serves: the request as the engine sent it, plus the one thing
 * the request itself cannot know — how long an agent has been blocked waiting
 * for an answer.
 */
export interface PendingRequest extends ApprovalRequest {
  waitingMs: number;
}

export interface TimelineEntry {
  ts: string;
  server?: string;
  tool?: string;
  command?: string;
  /** Whether the action went ahead. Absent for entries that record no decision. */
  allowed?: boolean;
  reason?: string;
  /** Which layer decided: the control plane, a security mode, the audit log. */
  source?: string;
}

export interface LiveStream {
  id: string;
  server: string;
  command: string;
  /** null while the command is still running. */
  code: number | null;
  scrollback: string;
  ts: string;
}

export interface Group {
  name: string;
  description?: string;
  servers: string[];
  strategy?: 'parallel' | 'sequential';
  delay?: number;
  stopOnError?: boolean;
  /** Built from the servers' own `group` field rather than named in a file. */
  dynamic?: boolean;
  fromConfig?: boolean;
  explicit?: boolean;
  serverCount: number;
}

export interface GroupRunEvent {
  type: 'group-run';
  id: string;
  group?: string;
  command?: string;
  state: 'started' | 'progress' | 'done' | 'failed';
  total?: number;
  done?: number;
  server?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export const groups = {
  save: (group: Omit<Group, 'serverCount'>) => post<{ ok: true; name: string }>('/api/groups', group),

  remove: async (name: string) => {
    const response = await fetch(url('/api/groups', { name }), { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  },

  /**
   * Answered immediately; results arrive on the event stream. A command across
   * twenty machines takes as long as the slowest one.
   */
  run: (group: string, command: string) =>
    post<{ id: string; servers: number }>('/api/groups/run', { group, command }),
};

export interface Options {
  groups: Group[];
  hostKeys: {
    host: string;
    port: number;
    /** A host can hold several keys of different types. */
    keys: { type: string; fingerprint: string }[];
  }[];
  tunnels: { id: string; description?: string }[];
  tunnelsStale: boolean;
}

export const hostKeys = {
  forget: async (host: string, port: number) => {
    const response = await fetch(url('/api/hostkey', { host, port }), { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  },
};

/**
 * The events that change the approval queue. Three, not one: a request appears
 * (`pending`), is answered (`resolved`), or vanishes because the agent that
 * asked went away (`expired`). Listening only for the first leaves a badge
 * showing a number that is no longer true.
 */
export const QUEUE_EVENTS = ['pending', 'resolved', 'expired'] as const;

export const state = {
  get: () => get<{ pending: PendingRequest[]; timeline: TimelineEntry[] }>('/api/state'),
  streams: () => get<{ streams: LiveStream[] }>('/api/streams'),
  options: () => get<Options>('/api/options'),
  decide: (id: string, approved: boolean) =>
    post('/api/decide', { id, decision: approved ? 'allow' : 'deny' }),

  /**
   * The live channel. One connection carries approvals, timeline entries,
   * command output and transfer progress; the caller filters by `type`.
   */
  subscribe(handler: (event: { type: string; [key: string]: unknown }) => void): () => void {
    const source = new EventSource(url('/api/events'));
    const listener = (event: MessageEvent) => {
      try { handler(JSON.parse(event.data)); } catch { /* a malformed frame is not worth a crash */ }
    };
    source.addEventListener('message', listener);
    return () => { source.removeEventListener('message', listener); source.close(); };
  },
};

export const api = { servers, groups, migration, files, local, transfers, shells, ssh, health, state, hostKeys };
export type Api = typeof api;
