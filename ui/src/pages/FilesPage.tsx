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
  const send = (from: Side) => (items: FileItem[]) => {
    const targetDir = pathsRef.current[from === 'local' ? 'remote' : 'local'];
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
    onDropFiles: (items: FileItem[]) => send(side === 'local' ? 'remote' : 'local')(items),
    onCopyPath: () => void navigator.clipboard?.writeText(pathsRef.current[side]),
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
