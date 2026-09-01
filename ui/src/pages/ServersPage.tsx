/**
 * The server list. `ServerGrid`, `CategoryGroup` and `ServerCard` are TransHub's
 * own components, unmodified — this page is the toolbar around them and the
 * wiring to the vault.
 */
import { useEffect, useState } from 'react';
import { LayoutGrid, List, Pencil, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ServerGrid } from '@/components/servers/ServerGrid';
import { ServerDialog } from '@/components/servers/ServerDialog';
import { MigrationBanner } from '@/components/servers/MigrationBanner';
import { useServersStore } from '@/stores/servers.store';
import type { ServerConfig } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { useWorkspace } from '@/stores/workspace';

export function ServersPage() {
  const { servers, load, remove, error, searchQuery, setSearchQuery, viewMode, setViewMode, editMode, setEditMode } =
    useServersStore();
  const [editing, setEditing] = useState<ServerConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const serverDraft = useWorkspace(state => state.serverDraft);
  const setServerDraft = useWorkspace(state => state.setServerDraft);

  useEffect(() => { void load(); }, [load]);

  // Somebody pressed "Add as a server" on a known host. Open the form with what
  // that screen knew, and clear the draft so returning here later does not
  // reopen it.
  useEffect(() => {
    if (!serverDraft) return;
    setAdding(true);
    return () => setServerDraft(null);
  }, [serverDraft, setServerDraft]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Servers" count={servers.length}>
        <div className="relative max-w-xs flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search"
            className="h-8 pl-8 text-xs"
          />
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={viewMode === 'grid' ? 'Show as a list' : 'Show as a grid'}
            onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
          >
            {viewMode === 'grid' ? <List className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
          </Button>
          <Button
            variant={editMode ? 'secondary' : 'ghost'}
            size="icon"
            aria-label="Toggle edit mode"
            onClick={() => setEditMode(!editMode)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add a server
          </Button>
        </div>
      </PageHeader>

      {error && (
        <p className="border-b border-destructive/30 bg-destructive-light px-6 py-2 text-sm">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <MigrationBanner onImported={() => void load()} />
        <ServerGrid
          onEditServer={setEditing}
          onDeleteServer={server => void remove(server.name)}
          onAddServer={() => setAdding(true)}
        />
      </div>

      {(adding || editing) && (
        <ServerDialog
          server={editing}
          prefill={editing ? undefined : serverDraft ?? undefined}
          onClose={() => { setAdding(false); setEditing(null); setServerDraft(null); }}
          onSaved={() => { setAdding(false); setEditing(null); setServerDraft(null); void load(); }}
        />
      )}
    </div>
  );
}
