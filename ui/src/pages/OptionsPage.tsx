/**
 * Groups, known host keys, tunnels — the state that lives in files and can
 * therefore be read from here.
 *
 * Tunnels are the exception worth explaining on screen: they live in a Map
 * inside the MCP server's own process, so this process can only see what that
 * one publishes. Showing a stale list would be worse than saying so.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Layers, Loader2, Network, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { state, hostKeys, type Options } from '@/lib/api';

export function OptionsPage() {
  const [options, setOptions] = useState<Options | null>(null);
  const [filter, setFilter] = useState('');
  const [forgetting, setForgetting] = useState<string | null>(null);

  const reload = () => state.options().then(setOptions).catch(() => {});
  useEffect(() => { void reload(); }, []);

  if (!options) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const matching = options.hostKeys.filter(entry =>
    entry.host.toLowerCase().includes(filter.trim().toLowerCase())
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">Options</h1>
      </header>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-6">
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
            <Layers className="h-3.5 w-3.5" />
            Groups
            <span className="text-muted-foreground">({options.groups.length})</span>
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {options.groups.map(group => (
              <div key={group.name} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{group.name}</span>
                  {group.dynamic && <Badge variant="secondary">dynamic</Badge>}
                  {group.fromConfig && <Badge variant="outline">from config</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {group.serverCount}
                  </span>
                </div>
                {group.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
                )}
                {group.servers.length > 0 && (
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {group.servers.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
            <Network className="h-3.5 w-3.5" />
            Tunnels
          </h2>
          {options.tunnels.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {options.tunnelsStale
                ? 'The published list is stale — the MCP server that opened them is no longer running.'
                : 'None open. Tunnels live inside the MCP server’s process; this screen shows what that process publishes.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {options.tunnels.map(tunnel => (
                <li key={tunnel.id} className="rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
                  {tunnel.description ?? tunnel.id}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
              <KeyRound className="h-3.5 w-3.5" />
              Known hosts
              <span className="text-muted-foreground">({options.hostKeys.length})</span>
            </h2>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter"
              className="ml-auto h-7 w-48 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            {matching.slice(0, 200).map(entry => {
              const key = `${entry.host}:${entry.port}`;
              return (
                <div key={key} className="group flex items-center gap-3 border-b border-border-subtle px-3 py-1.5 last:border-b-0 hover:bg-card-hover">
                  <span className="w-56 shrink-0 truncate font-mono text-xs">{entry.host}</span>
                  {entry.port !== 22 && <span className="text-[10px] text-muted-foreground">:{entry.port}</span>}
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                    {/* One host can hold several keys of different types, which
                        is why this reads the array rather than a single field. */}
                    {entry.keys.map(k => k.type).join(', ')}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Forget ${entry.host}`}
                    className="opacity-0 group-hover:opacity-100"
                    disabled={forgetting === key}
                    onClick={async () => {
                      if (!window.confirm(`Forget the host key for ${entry.host}?`)) return;
                      setForgetting(key);
                      try {
                        await hostKeys.forget(entry.host, entry.port);
                        await reload();
                      } finally {
                        setForgetting(null);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
            {matching.length > 200 && (
              <p className="px-3 py-2 text-[10px] text-muted-foreground">
                {matching.length - 200} more — narrow the filter to see them.
              </p>
            )}
            {matching.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">No host matches.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
