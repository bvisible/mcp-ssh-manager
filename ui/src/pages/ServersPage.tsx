/**
 * The server list. Follows TransHub's ServerCard: a card per machine, actions
 * revealed on hover rather than always shown, and the two things you actually
 * do with a server — open a shell, open its files — as the primary buttons.
 */
import { useEffect, useState } from 'react';
import { FolderTree, Monitor, Pencil, Plus, TerminalSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/stores/workspace';
import { servers as api, type ServerConfig } from '@/lib/api';
import { ServerDialog } from '@/components/servers/ServerDialog';

export function ServersPage() {
  const [servers, setServers] = useState<ServerConfig[] | null>(null);
  const [editing, setEditing] = useState<ServerConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openSession = useWorkspace(s => s.openSession);

  const reload = () =>
    api
      .list()
      .then(setServers)
      .catch(e => setError(e.message));

  useEffect(() => { void reload(); }, []);

  return (
    <>
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-medium">Servers</h1>
          <p className="text-sm text-muted-foreground">
            Held in the encrypted vault. Secrets are never sent back to this page.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          Add a server
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error && (
          <p className="mb-4 rounded-md border border-destructive/30 bg-destructive-light px-3 py-2 text-sm">
            {error}
          </p>
        )}

        {servers === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {[0, 1, 2].map(i => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing in the vault yet. Add a server above, or run{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">ssh-manager vault import</code>{' '}
            to bring over what is already in your <code className="font-mono text-xs">.env</code>.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {servers.map(server => (
              <article
                key={server.id}
                className="group relative rounded-lg border border-border bg-card shadow-card transition-colors hover:bg-card-hover"
              >
                <div className="flex items-start gap-2.5 p-3 pb-2">
                  <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{server.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {server.username ? `${server.username}@` : ''}
                      {server.host}
                      {server.port !== 22 && `:${server.port}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(server)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete"
                      onClick={async () => {
                        await api.remove(server.name);
                        void reload();
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1 px-3">
                  {server.category && <Badge variant="secondary">{server.category}</Badge>}
                  {server.mode && server.mode !== 'unrestricted' && (
                    <Badge variant="outline">{server.mode}</Badge>
                  )}
                  {server.approval && server.approval !== 'never' && (
                    <Badge variant="outline">asks: {server.approval}</Badge>
                  )}
                  {(server.accounts?.length ?? 0) > 1 && (
                    <Badge variant="secondary">{server.accounts!.length} accounts</Badge>
                  )}
                </div>

                <div className="flex gap-1 p-3 pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={() => openSession(server.name, 'shell')}
                  >
                    <TerminalSquare className="h-3.5 w-3.5" />
                    Shell
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={() => openSession(server.name, 'files')}
                  >
                    <FolderTree className="h-3.5 w-3.5" />
                    Files
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {(adding || editing) && (
        <ServerDialog
          server={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); void reload(); }}
        />
      )}
    </>
  );
}
