/**
 * The terminal, as a place you can go rather than a button on a card.
 *
 * A shell has always been reachable here — from the `>_` on a server card —
 * which is fine once you know it and invisible until then. Somebody who wants
 * "a terminal on production, so I can run Claude Code on it" has no reason to
 * look inside a card for that, and the feature may as well not exist.
 *
 * So: pick a machine, get a shell. And beside it, the commands you keep
 * retyping, because the other half of what people mean by "a terminal" is not
 * having to remember the incantation.
 */
import { useEffect, useState } from 'react';
import { Plus, TerminalSquare, Play, Pencil, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CommandDialog } from '@/components/commands/CommandDialog';
import { useServersStore } from '@/stores/servers.store';
import { useWorkspace } from '@/stores/workspace';
import { commands as commandsApi, type SavedCommand } from '@/lib/api';

/** Ids have to be unique across tabs; the shape does not matter beyond that. */
const newId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function TerminalPage() {
  const { servers, load } = useServersStore();
  const { tabs, addTab, activateTab } = useWorkspace();
  const [saved, setSaved] = useState<SavedCommand[]>([]);
  const [suggestions, setSuggestions] = useState<Omit<SavedCommand, 'id'>[]>([]);
  const [editing, setEditing] = useState<SavedCommand | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { void load(); }, [load]);

  const loadCommands = async () => {
    try {
      const answer = await commandsApi.list();
      setSaved(answer.commands);
      setSuggestions(answer.suggestions);
    } catch {
      // The list is a convenience; failing to read it must not empty the screen.
    }
  };
  useEffect(() => { void loadCommands(); }, []);

  /**
   * Open a shell, or raise the one that is already open.
   *
   * A second shell on the same machine is a legitimate thing to want, but it is
   * almost never what a click on this row means — and two identical tabs is a
   * confusing thing to be given by surprise.
   */
  const openShell = (serverId: string, name: string) => {
    const existing = tabs.find(tab => tab.type === 'ssh-terminal' && tab.serverId === serverId);
    if (existing) return activateTab(existing.id);
    addTab({ id: newId(), type: 'ssh-terminal', title: name, serverId });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Terminal"
        count={servers.length}
        hint="A shell on any machine — and the commands you would rather not retype."
      />

      <Tabs defaultValue="open" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-6 mt-4 w-fit shrink-0">
          <TabsTrigger value="open">Open a shell</TabsTrigger>
          <TabsTrigger value="commands">Saved commands</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <TabsContent value="open" className="mt-0">
            {servers.length === 0 ? (
              <EmptyState
                icon={TerminalSquare}
                title="No servers yet"
                hint="Add one under Servers, or import what you already have with `ssh-manager import`."
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {servers.map(server => {
                  const open = tabs.some(
                    tab => tab.type === 'ssh-terminal' && tab.serverId === server.id);
                  return (
                    <button
                      key={server.id}
                      onClick={() => openShell(server.id, server.name)}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-card-hover"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <TerminalSquare className="h-4.5 w-4.5 text-primary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{server.name}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {server.username ? `${server.username}@` : ''}{server.host}
                        </span>
                      </span>
                      {open && <Badge variant="secondary" className="shrink-0">open</Badge>}
                    </button>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="commands" className="mt-0 space-y-4">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Picked from a list inside any shell, instead of typed again.
              </p>
              <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                New command
              </Button>
            </div>

            {saved.length === 0 ? (
              <EmptyState
                icon={Play}
                title="Nothing saved yet"
                hint="Save the ones you type most. They appear in every shell, on the servers you choose."
                action={
                  <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    Save a command
                  </Button>
                }
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {saved.map(command => (
                  <div
                    key={command.id}
                    className="group flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0 hover:bg-card-hover"
                  >
                    <span className="w-40 shrink-0 truncate text-sm">{command.name}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {command.command}
                    </code>
                    {command.confirmBeforeRun && (
                      <Badge variant="outline" className="shrink-0">asks first</Badge>
                    )}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {command.serverNames?.length
                        ? command.serverNames.join(', ')
                        : 'every server'}
                    </span>
                    <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${command.name}`}
                        onClick={() => setEditing(command)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Delete ${command.name}`}
                        onClick={async () => {
                          if (!window.confirm(`Delete “${command.name}”?`)) return;
                          await commandsApi.remove(command.id);
                          void loadCommands();
                        }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {suggestions.length > 0 && (
              <div>
                <h2 className="mb-2 text-xs font-medium tracking-wider uppercase text-muted-foreground">
                  Suggestions
                </h2>
                {/* Offered, never installed. A list somebody did not choose is a
                    list they have to read past every time. */}
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map(suggestion => (
                    <Button
                      key={suggestion.name}
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await commandsApi.save(suggestion);
                        void loadCommands();
                      }}
                    >
                      <Plus className="h-3 w-3" />
                      {suggestion.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      {(creating || editing) && (
        <CommandDialog
          existing={editing ?? undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void loadCommands(); }}
        />
      )}
    </div>
  );
}
