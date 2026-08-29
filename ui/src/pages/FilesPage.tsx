/**
 * The remote file browser, following TransHub's FilePane: sortable columns,
 * breadcrumb navigation, selection, and the operations you reach for on a
 * server — rename, delete, make a directory, upload, download.
 *
 * Deliberately one pane rather than TransHub's dual local/remote layout. The
 * control plane is a page in a browser: it has no access to your local
 * filesystem beyond the file picker and the downloads folder, so a "local"
 * pane would be a lie. Upload is a picker, download is a browser download.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, ChevronRight, File, Folder, FolderPlus, Link2, Loader2, RefreshCw, Trash2, Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { files as api, type RemoteFileInfo } from '@/lib/api';
import { cn } from '@/lib/utils';

type SortField = 'name' | 'size' | 'modifyTime';

/** Bytes as a human reads them, not as a machine stores them. */
function formatSize(bytes: number, isDirectory: boolean): string {
  if (isDirectory) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The `rwxr-xr-x` form, which is what anyone administering a server reads. */
function formatMode(mode: number): string {
  const bits = 'rwxrwxrwx';
  return [...bits].map((bit, i) => (mode & (1 << (8 - i)) ? bit : '-')).join('');
}

export function FilesPage({ server }: { server: string }) {
  const [path, setPath] = useState('.');
  const [entries, setEntries] = useState<RemoteFileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<{ field: SortField; asc: boolean }>({ field: 'name', asc: true });
  const [busy, setBusy] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (target: string) => {
      setError(null);
      return api
        .list(server, target)
        .then(result => {
          setEntries(result.entries);
          setPath(result.path);
          setSelected(null);
        })
        .catch(e => setError(e.message));
    },
    [server]
  );

  useEffect(() => { void load('.'); }, [load]);

  const sorted = useMemo(() => {
    if (!entries) return null;
    const direction = sort.asc ? 1 : -1;
    return [...entries].sort((a, b) => {
      // Directories first, always: it is how every file manager behaves and
      // sorting them in with the files makes a deep tree unreadable.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      if (sort.field === 'name') return a.name.localeCompare(b.name) * direction;
      return (a[sort.field] - b[sort.field]) * direction;
    });
  }, [entries, sort]);

  const segments = path === '.' || path === '/' ? [] : path.split('/').filter(Boolean);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await load(path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="shrink-0 text-sm font-medium">{server}</h1>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground">
          <button className="shrink-0 rounded px-1 py-0.5 hover:bg-accent" onClick={() => void load('/')}>
            /
          </button>
          {segments.map((segment, index) => (
            <span key={index} className="flex shrink-0 items-center gap-0.5">
              <ChevronRight className="h-3 w-3" />
              <button
                className="rounded px-1 py-0.5 hover:bg-accent"
                onClick={() => void load(`/${segments.slice(0, index + 1).join('/')}`)}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Button variant="ghost" size="icon" aria-label="Up one level"
            onClick={() => void load(segments.slice(0, -1).join('/') ? `/${segments.slice(0, -1).join('/')}` : '/')}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void load(path)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="New folder"
            onClick={() => {
              const name = window.prompt('Name of the new directory');
              if (name) void act(() => api.mkdir(server, `${path === '/' ? '' : path}/${name}`));
            }}>
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Upload" onClick={() => uploadRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
          </Button>
          <input
            ref={uploadRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => {
              const chosen = [...(event.target.files ?? [])];
              event.target.value = '';
              if (chosen.length) {
                void act(async () => {
                  for (const file of chosen) {
                    await api.upload(server, `${path === '/' ? '' : path}/${file.name}`, file);
                  }
                });
              }
            }}
          />
        </div>
      </header>

      {error && (
        <p className="border-b border-destructive/30 bg-destructive-light px-6 py-2 text-sm">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {([['name', 'Name'], ['size', 'Size'], ['modifyTime', 'Modified']] as const).map(([field, label]) => (
                <th key={field} className="px-6 py-2 font-medium">
                  <button
                    className="hover:text-foreground"
                    onClick={() => setSort(s => ({ field, asc: s.field === field ? !s.asc : true }))}
                  >
                    {label}{sort.field === field && (sort.asc ? ' ↑' : ' ↓')}
                  </button>
                </th>
              ))}
              <th className="px-6 py-2 font-medium">Mode</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {sorted?.map(entry => (
              <tr
                key={entry.path}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => {
                  if (entry.isDirectory) void load(entry.path);
                  else window.open(api.downloadUrl(server, entry.path), '_blank');
                }}
                className={cn(
                  'group cursor-default border-b border-border-subtle',
                  selected === entry.path ? 'bg-sidebar-accent' : 'hover:bg-card-hover'
                )}
              >
                <td className="flex items-center gap-2 px-6 py-1.5">
                  {entry.isSymlink ? (
                    <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : entry.isDirectory ? (
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </td>
                <td className="px-6 py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatSize(entry.size, entry.isDirectory)}
                </td>
                <td className="px-6 py-1.5 tabular-nums text-muted-foreground">
                  {entry.modifyTime ? new Date(entry.modifyTime).toLocaleString() : '—'}
                </td>
                <td className="px-6 py-1.5 font-mono text-xs text-muted-foreground">
                  {formatMode(entry.permissions)}
                </td>
                <td className="pr-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${entry.name}`}
                    className="opacity-0 group-hover:opacity-100"
                    onClick={event => {
                      event.stopPropagation();
                      if (window.confirm(`Delete ${entry.name}?`)) {
                        void act(() => api.remove(server, entry.path, entry.isDirectory));
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted?.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">This directory is empty.</p>
        )}
        {sorted === null && !error && (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        )}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-6 py-2 text-xs text-muted-foreground">
        <span>{sorted?.length ?? 0} {sorted?.length === 1 ? 'item' : 'items'}</span>
        <span className="truncate font-mono">{path}</span>
      </footer>
    </>
  );
}
