/**
 * The dual-pane file browser: this machine on the left, the server on the right.
 *
 * Both panes are TransHub's `FilePane`, unmodified — it is already generic over
 * `isLocal` and driven entirely by props, which is why it drops straight in.
 * The work here is supplying those props against the control plane's routes.
 *
 * The local pane is possible because the control plane is a Node process
 * running on the operator's own machine. A page in a browser could not read
 * that disk; the page is not what reads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import { FilePane, type FileItem } from '@/components/browser/FilePane';
import { files as remote, local, transfers, state, type TransferEvent } from '@/lib/api';
import { useWorkspace } from '@/stores/workspace';

type Side = 'local' | 'remote';

interface PaneState {
  path: string;
  files: FileItem[];
  loading: boolean;
  selected: Set<string>;
}

const EMPTY: PaneState = { path: '', files: [], loading: true, selected: new Set() };

export function FilesPage({ server }: { server: string }) {
  const [panes, setPanes] = useState<Record<Side, PaneState>>({ local: EMPTY, remote: EMPTY });
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferEvent | null>(null);
  // Anchor for shift-click ranges, per pane, as a file manager behaves.
  const anchors = useRef<Record<Side, string | null>>({ local: null, remote: null });
  // Read inside callbacks that must not be rebuilt every time a path changes.
  const pathsRef = useRef<Record<Side, string>>({ local: '', remote: '' });

  const update = (side: Side, patch: Partial<PaneState>) =>
    setPanes(current => ({ ...current, [side]: { ...current[side], ...patch } }));

  const load = useCallback(
    async (side: Side, target?: string) => {
      update(side, { loading: true });
      try {
        const result = side === 'local' ? await local.list(target) : await remote.list(server, target ?? '.');
        pathsRef.current[side] = result.path;
        update(side, { path: result.path, files: result.entries, loading: false, selected: new Set() });
        anchors.current[side] = null;
      } catch (e) {
        update(side, { loading: false });
        setError((e as Error).message);
      }
    },
    [server]
  );

  useEffect(() => {
    void load('local');
    void load('remote');
  }, [load]);

  // Progress arrives on the shared event stream rather than by polling, and a
  // finished transfer refreshes the side it landed on.
  useEffect(() => {
    const stop = state.subscribe(event => {
      if (event.type !== 'transfer') return;
      const progress = event as unknown as TransferEvent;
      setTransfer(progress.state === 'done' || progress.state === 'failed' ? null : progress);
      if (progress.state === 'done') void load(progress.direction === 'upload' ? 'remote' : 'local');
      if (progress.state === 'failed') setError(progress.error ?? 'The transfer failed');
    });
    return stop;
  }, [load]);

  /** Click, ctrl-click and shift-click, which is what a file list has to do. */
  const select = (side: Side) => (path: string, multi: boolean, range: boolean) =>
    setPanes(current => {
      const pane = current[side];
      let selected: Set<string>;
      if (range && anchors.current[side]) {
        const order = pane.files.map(f => f.path);
        const from = order.indexOf(anchors.current[side]!);
        const to = order.indexOf(path);
        const [start, end] = from < to ? [from, to] : [to, from];
        selected = new Set(order.slice(start, end + 1));
      } else if (multi) {
        selected = new Set(pane.selected);
        if (selected.has(path)) selected.delete(path);
        else selected.add(path);
        anchors.current[side] = path;
      } else {
        selected = new Set([path]);
        anchors.current[side] = path;
      }
      return { ...current, [side]: { ...pane, selected } };
    });

  const open = (side: Side) => (file: FileItem) => {
    if (file.isDirectory) return void load(side, file.path);
    if (side === 'remote') window.open(remote.downloadUrl(server, file.path), '_blank');
  };

  const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

  /** Send a selection to the other side, into whatever directory it is showing. */
  /**
   * Move files from one pane to the other.
   *
   * `destination` is where the drop actually landed: dropping on a folder row
   * targets that folder, and the row already passes its path all the way down
   * to FilePane's handleDrop. This function used to ignore it and recompute the
   * other pane's current directory, so a file dropped onto `backups/` landed
   * beside it instead of inside — every folder on screen was a drop target that
   * quietly did the wrong thing.
   */
  const send = (from: Side) => (items: FileItem[], destination?: string) => {
    const targetDir = destination || pathsRef.current[from === 'local' ? 'remote' : 'local'];
    const files = items.filter(item => !item.isDirectory);
    if (files.length === 0) {
      // Directories would need a recursive walk on both sides; saying so beats
      // transferring nothing and looking broken.
      setError('Directories cannot be transferred yet — select files.');
      return;
    }
    void transfers
      .start({
        server,
        direction: from === 'local' ? 'upload' : 'download',
        items: files.map(item =>
          from === 'local'
            ? { local: item.path, remote: join(targetDir, item.name) }
            : { local: join(targetDir, item.name), remote: item.path }
        ),
      })
      .catch(e => setError((e as Error).message));
  };

  const remove = (side: Side) => async (items: FileItem[]) => {
    if (!window.confirm(`Delete ${items.length === 1 ? items[0].name : `${items.length} items`}?`)) return;
    try {
      for (const item of items) {
        if (side === 'local') await local.remove(item.path, item.isDirectory);
        else await remote.remove(server, item.path, item.isDirectory);
      }
      await load(side, pathsRef.current[side]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = (side: Side) => async (file: FileItem) => {
    const next = window.prompt('New name', file.name);
    if (!next || next === file.name) return;
    const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
    try {
      if (side === 'local') await local.rename(file.path, join(parent, next));
      else await remote.rename(server, file.path, join(parent, next));
      await load(side, pathsRef.current[side]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createFolder = (side: Side) => async () => {
    const name = window.prompt('Name of the new directory');
    if (!name) return;
    const dir = pathsRef.current[side];
    try {
      if (side === 'local') await local.mkdir(join(dir, name));
      else await remote.mkdir(server, join(dir, name));
      await load(side, dir);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Join a directory and a name with the separator that side of the pair uses. */
  const { tabs, addTab, activateTab } = useWorkspace();

  const joinPath = (dir: string, name: string) =>
    dir.includes('\\') && !dir.startsWith('/')
      ? `${dir.replace(/\\$/, '')}\\${name}`
      : `${dir.replace(/\/$/, '')}/${name}`;

  const paneProps = (side: Side) => ({
    isLocal: side === 'local',
    files: panes[side].files,
    currentPath: panes[side].path,
    loading: panes[side].loading,
    selectedFiles: panes[side].selected,
    onNavigate: (path: string) => void load(side, path),
    onRefresh: () => void load(side, pathsRef.current[side]),
    onSelect: select(side),
    onOpen: open(side),
    onCreateFolder: createFolder(side),
    onDelete: remove(side),
    onRename: rename(side),
    onTransfer: send(side),
    transferLabel: side === 'local' ? 'Upload' : 'Download',
    // Dropping a selection carries it from the pane it was dragged out of, so
    // the direction is the opposite of the pane receiving the drop.
    onDropFiles: (items: FileItem[], destination?: string) =>
      send(side === 'local' ? 'remote' : 'local')(items, destination),
    onCopyPath: () => void navigator.clipboard?.writeText(pathsRef.current[side]),

    // Nine of the context menu's fifteen actions had no handler. Six of those
    // still rendered — a menu item that silently does nothing is worse than one
    // that is not there — so the ones that can be backed are wired here, and
    // FilePane hides the rest.
    onCreateFile: () => {
      const name = window.prompt('Name for the new file');
      if (!name?.trim()) return;
      const target = joinPath(pathsRef.current[side], name.trim());
      void (async () => {
        try {
          if (side === 'local') await local.touch(target);
          else await remote.write(server, target, '');
          await load(side, pathsRef.current[side]);
        } catch (e) { setError((e as Error).message); }
      })();
    },

    // Only the local pane: there is no Finder on the other end of an SSH
    // connection, and FilePane already hides it when the handler is absent.
    onShowInFinder: side === 'local'
      ? (target: string) => void local.reveal(target).catch(
          (e: Error) => setError(e.message))
      : undefined,

    // Only the remote pane, and it opens the shell this application already
    // has rather than handing off to Terminal.app.
    onOpenTerminal: side === 'remote'
      ? () => {
          const existing = tabs.find(
            tab => tab.type === 'ssh-terminal' && tab.title === server);
          if (existing) return activateTab(existing.id);
          addTab({
            id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'ssh-terminal', title: server, serverId: server,
          });
        }
      : undefined,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive-light px-4 py-2 text-sm">
          <span>{error}</span>
          <button className="text-xs underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
      {transfer && (
        <div className="border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground">
          {transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} — {transfer.done} of {transfer.total}
          {transfer.file && <span className="ml-2 font-mono">{transfer.file}</span>}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <Allotment defaultSizes={[1, 1]}>
          <Allotment.Pane minSize={260}>
            <FilePane title="This machine" {...paneProps('local')} onGoHome={() => void load('local')} />
          </Allotment.Pane>
          <Allotment.Pane minSize={260}>
            <FilePane
              title={server}
              {...paneProps('remote')}
              onGoHome={() => void load('remote', '.')}
              onGoRoot={() => void load('remote', '/')}
            />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
}
