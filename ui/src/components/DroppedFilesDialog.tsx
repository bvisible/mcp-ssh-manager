/**
 * Where should the file you dropped on the Dock icon go?
 *
 * There is no sensible default. "The last server" is wrong the first time and
 * whenever you have two open; "ask every time" is only annoying if the question
 * is a bad one. So the question is short and the answers are ordered by what is
 * already in front of you: a machine whose files you are looking at, then one
 * you have a shell on, then the rest.
 *
 * Every choice says where the file will land before you make it. A transfer
 * that puts a file somewhere you did not expect is worse than one that asks.
 */
import { useEffect, useState } from 'react';
import { FolderOpen, TerminalSquare, Server as ServerIcon, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useServersStore } from '@/stores/servers.store';
import { useWorkspace } from '@/stores/workspace';
import { transfers } from '@/lib/api';

/** Just the file name, for a list that has to stay readable. */
const baseName = (full: string) => full.split(/[\\/]/).pop() || full;

export interface DroppedFilesDialogProps {
  paths: string[];
  onClose: () => void;
}

export function DroppedFilesDialog({ paths, onClose }: DroppedFilesDialogProps) {
  const { servers, load } = useServersStore();
  const { tabs, addTab, activateTab } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void load(); }, [load]);

  // Escape closes it: a dialog you cannot dismiss from the keyboard is a trap,
  // and this one appears without being asked for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const browsing = new Set(
    tabs.filter(tab => tab.type === 'dual-browser').map(tab => tab.serverId));
  const shelled = new Set(
    tabs.filter(tab => tab.type === 'ssh-terminal').map(tab => tab.serverId));

  /** Open first, then shells, then the rest — nearest to hand at the top. */
  const ranked = [...servers].sort((a, b) => {
    const weight = (s: typeof a) =>
      browsing.has(s.id) ? 0 : shelled.has(s.id) ? 1 : 2;
    return weight(a) - weight(b) || a.name.localeCompare(b.name);
  });

  const sendTo = async (server: typeof servers[number]) => {
    setBusy(server.id);
    setError(null);
    try {
      const target = server.defaultDirectory || '.';
      await transfers.start({
        server: server.name,
        direction: 'upload',
        items: paths.map(local => ({
          local,
          remote: `${target.replace(/\/$/, '')}/${baseName(local)}`,
        })),
      });
      // Land them somewhere they can see it: the file browser for that machine,
      // raised if it is already open.
      const existing = tabs.find(
        tab => tab.type === 'dual-browser' && tab.serverId === server.id);
      if (existing) activateTab(existing.id);
      else {
        addTab({
          id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'dual-browser', title: server.name, serverId: server.id,
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Upload className="h-4.5 w-4.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">
              Send {paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`} where?
            </h2>
            {paths.length > 1 && (
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {paths.map(baseName).join(', ')}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" aria-label="Cancel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {error && (
          <p className="border-b border-destructive/30 bg-destructive-light px-5 py-2 text-xs">
            {error}
          </p>
        )}

        <div className="max-h-80 overflow-y-auto p-2">
          {ranked.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              No servers configured yet.
            </p>
          )}
          {ranked.map(server => {
            const open = browsing.has(server.id);
            const shell = shelled.has(server.id);
            const Icon = open ? FolderOpen : shell ? TerminalSquare : ServerIcon;
            return (
              <button
                key={server.id}
                disabled={busy !== null}
                onClick={() => void sendTo(server)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-card-hover disabled:opacity-50"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{server.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {server.defaultDirectory || '~'}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {open ? 'files open' : shell ? 'shell open' : ''}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
