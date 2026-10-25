/**
 * The server list. `ServerGrid`, `CategoryGroup` and `ServerCard` came from
 * TransHub; this page is the toolbar around them and the wiring to the vault.
 *
 * It is also the screen the application opens on, so it carries the one thing
 * that cannot wait: a command an agent has paused on. The badge on the rail
 * says a number; the banner here says which server and what command, one click
 * from the answer.
 */
import { useEffect, useMemo, useState } from 'react';
import { Clock, LayoutGrid, List, Pencil, Plus, Search, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ServerGrid } from '@/components/servers/ServerGrid';
import { ServerDialog } from '@/components/servers/ServerDialog';
import { MigrationBanner } from '@/components/servers/MigrationBanner';
import { useServersStore } from '@/stores/servers.store';
import type { ServerConfig, PendingRequest } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { useWorkspace } from '@/stores/workspace';
import { ImportDialog } from '@/components/servers/ImportDialog';
import { usePendingRequests } from '@/lib/use-pending';
import { cn } from '@/lib/utils';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function ServersPage() {
  const {
    servers, load, remove, error, searchQuery, setSearchQuery, viewMode, setViewMode, editMode, setEditMode,
    categoryFilter, setCategoryFilter,
  } = useServersStore();
  const [editing, setEditing] = useState<ServerConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const wantsImport = useWorkspace(state => state.wantsImport);
  const setWantsImport = useWorkspace(state => state.setWantsImport);
  const wantsAdd = useWorkspace(state => state.wantsAdd);
  const setWantsAdd = useWorkspace(state => state.setWantsAdd);
  const serverDraft = useWorkspace(state => state.serverDraft);
  const setServerDraft = useWorkspace(state => state.setServerDraft);
  const setView = useWorkspace(state => state.setView);
  const { pending } = usePendingRequests();

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!wantsAdd) return;
    setAdding(true);
    setWantsAdd(false);
  }, [wantsAdd, setWantsAdd]);

  // Somebody pressed Import somewhere else — the introduction, most likely.
  useEffect(() => {
    if (!wantsImport) return;
    setImporting(true);
    setWantsImport(false);
  }, [wantsImport, setWantsImport]);

  // Somebody pressed "Add as a server" on a known host. Open the form with what
  // that screen knew, and clear the draft so returning here later does not
  // reopen it.
  useEffect(() => {
    if (!serverDraft) return;
    setAdding(true);
    return () => setServerDraft(null);
  }, [serverDraft, setServerDraft]);

  // Every group with its full size, whatever the search says: the chips are
  // how you narrow the list, so they must not narrow themselves.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const server of servers) {
      const name = server.category || 'Uncategorized';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [servers]);

  // A group that no longer exists cannot stay selected: the list would read as
  // empty with nothing on screen saying why.
  useEffect(() => {
    if (categoryFilter !== null && !groups.some(([name]) => name === categoryFilter)) setCategoryFilter(null);
  }, [groups, categoryFilter, setCategoryFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Servers"
        hint={servers.length > 0
          ? `${plural(servers.length, 'server')} in ${plural(groups.length, 'group')}. Your agents reach them through this engine.`
          : undefined}
        actions={
          <>
            <Button
              variant={editMode ? 'secondary' : 'ghost'}
              size="icon"
              aria-label="Toggle edit mode"
              aria-pressed={editMode}
              title={editMode ? 'Done editing' : 'Edit or remove servers'}
              onClick={() => setEditMode(!editMode)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            {/* Import sits beside Add, not behind it. It was reachable only from
                the CLI, which made seven working format readers invisible to
                anybody who had not read the source. */}
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Download className="h-4 w-4" />
              Import
            </Button>
            <Button className="font-bold" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add a server
            </Button>
          </>
        }
      />

      {error && (
        <p className="border-b border-destructive/30 bg-destructive-light px-8 py-2 text-sm">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-5">
        <MigrationBanner onImported={() => void load()} />
        {pending.length > 0 && <WaitingBanner pending={pending} onOpen={() => setView('waiting')} />}

        {servers.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] max-w-md flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search a name, host or user"
                aria-label="Search servers"
                className="h-10 bg-card pl-9 text-sm"
              />
            </div>

            {/* Only worth showing with more than one group to choose from. */}
            {groups.length > 1 && (
              <div role="group" aria-label="Filter by group" className="flex flex-wrap gap-1.5">
                <FilterChip
                  label="All"
                  count={servers.length}
                  active={categoryFilter === null}
                  onClick={() => setCategoryFilter(null)}
                  ariaLabel="Show every group"
                />
                {groups.map(([name, count]) => (
                  <FilterChip
                    key={name}
                    label={name}
                    count={count}
                    active={categoryFilter === name}
                    onClick={() => setCategoryFilter(categoryFilter === name ? null : name)}
                    ariaLabel={`Show only ${name}`}
                  />
                ))}
              </div>
            )}

            <div role="group" aria-label="Layout" className="ml-auto flex overflow-hidden rounded-lg border border-border bg-card">
              <button
                type="button"
                aria-label="Show as a grid"
                aria-pressed={viewMode === 'grid'}
                title="Cards"
                onClick={() => setViewMode('grid')}
                className={cn('flex h-[38px] w-10 items-center justify-center transition-colors',
                  viewMode === 'grid' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Show as a list"
                aria-pressed={viewMode === 'list'}
                title="List"
                onClick={() => setViewMode('list')}
                className={cn('flex h-[38px] w-10 items-center justify-center border-l border-border transition-colors',
                  viewMode === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        <ServerGrid
          onImportServers={() => setImporting(true)}
          onEditServer={setEditing}
          onDeleteServer={server => void remove(server.name)}
          onAddServer={() => setAdding(true)}
        />
      </div>

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); void load(); }}
        />
      )}

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

function WaitingBanner({ pending, onOpen }: { pending: PendingRequest[]; onOpen: () => void }) {
  // The longest-waiting first: it is the agent that has been blocked longest.
  const first = [...pending].sort((a, b) => b.waitingMs - a.waitingMs)[0];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-5 flex w-full flex-wrap items-center gap-x-3.5 gap-y-1 rounded-xl bg-accent px-4 py-3 text-left text-accent-foreground transition-colors hover:bg-accent/70"
    >
      <Clock className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
      <span className="font-bold">
        {pending.length === 1
          ? '1 command is waiting for your decision'
          : `${pending.length} commands are waiting for your decision`}
      </span>
      <span className="min-w-0 flex-[1_1_240px] truncate font-mono text-[12.5px]">
        {first.server} · {first.command || first.tool}
      </span>
      <span className="font-bold">Review →</span>
    </button>
  );
}

function FilterChip({ label, count, active, onClick, ariaLabel }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        'h-8 rounded-full border px-3 text-[13px] transition-colors',
        active
          ? 'border-foreground bg-foreground font-bold text-background'
          : 'border-border bg-card text-foreground hover:bg-secondary'
      )}
    >
      {label} <span className={active ? '' : 'text-muted-foreground'}>{count}</span>
    </button>
  );
}
