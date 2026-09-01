/**
 * Groups, known host keys, tunnels — the state that lives in files and can
 * therefore be read from here.
 *
 * Tunnels are the exception worth explaining on screen: they live in a Map
 * inside the MCP server's own process, so this process can only see what that
 * one publishes. Showing a stale list would be worse than saying so.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Layers, Loader2, Monitor, Moon, Network, Palette, Pencil, Play, Plus, Sun, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { state, hostKeys, groups as groupsApi, thresholds as thresholdsApi, type Options, type Group, type GroupRunEvent, type Thresholds } from '@/lib/api';
import { GroupDialog } from '@/components/servers/GroupDialog';
import { useServersStore } from '@/stores/servers.store';
import { useWorkspace } from '@/stores/workspace';
import { useTheme, type ThemeMode } from '@/stores/theme';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';


const THEMES: { id: ThemeMode; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'system', label: 'Match the desktop', hint: 'follows your system setting, including when it changes', icon: Monitor },
  { id: 'light', label: 'Light', hint: 'always light, whatever the system does', icon: Sun },
  { id: 'dark', label: 'Dark', hint: 'always dark', icon: Moon },
];

/**
 * Matching the desktop is first and is the default: an application that ignores
 * the system setting is one you have to configure twice, and most people never
 * do the second time.
 */
function ThemePicker() {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {THEMES.map(theme => {
        const Icon = theme.icon;
        const active = mode === theme.id;
        return (
          <button
            key={theme.id}
            onClick={() => setMode(theme.id)}
            aria-pressed={active}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              active
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-card-hover'
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground')} />
              <span className="text-sm font-medium">{theme.label}</span>
              {theme.id === 'system' && (
                <span className="ml-auto text-[10px] text-muted-foreground">currently {resolved}</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{theme.hint}</p>
          </button>
        );
      })}
    </div>
  );
}


/**
 * The levels at which a machine is worth mentioning.
 *
 * Held on this machine, not pushed onto the servers. The engine's
 * `ssh_alert_setup` writes a config file onto each box; that is a lot of blast
 * radius for three numbers, and it only helps something running *there* —
 * nothing does. The watching happens here, when you press the health button.
 */
function Thresholds() {
  const [limits, setLimits] = useState<Thresholds | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void thresholdsApi.get().then(r => setLimits(r.thresholds)).catch(() => {});
  }, []);

  if (!limits) return null;

  const update = (patch: Partial<Thresholds>) => {
    const next = { ...limits, ...patch };
    setLimits(next);
    setSaving(true);
    void thresholdsApi.save(next).finally(() => setSaving(false));
  };

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={limits.enabled}
          onChange={e => update({ enabled: e.target.checked })}
          className="h-3.5 w-3.5"
        />
        Point out machines over these levels
        <span className="text-xs text-muted-foreground">
          {/* Said plainly: nothing runs on a timer, here or on the servers. */}
          — checked when you probe, never in the background
        </span>
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </label>

      <div className="grid grid-cols-3 gap-3">
        {([['cpu', 'CPU'], ['memory', 'Memory'], ['disk', 'Disk']] as const).map(([key, label]) => (
          <div key={key} className="grid gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={1}
                max={100}
                value={limits[key]}
                disabled={!limits.enabled}
                onChange={e => update({ [key]: Number(e.target.value) || limits[key] })}
                className="h-8"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OptionsPage() {
  const [options, setOptions] = useState<Options | null>(null);
  const [filter, setFilter] = useState('');
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [run, setRun] = useState<GroupRunEvent | null>(null);
  const [output, setOutput] = useState<GroupRunEvent[]>([]);
  const loadServers = useServersStore(s => s.load);
  const servers = useServersStore(s => s.servers);
  const setView = useWorkspace(s => s.setView);
  const setServerDraft = useWorkspace(s => s.setServerDraft);

  const reload = () => state.options().then(setOptions).catch(() => {});
  useEffect(() => {
    void reload();
    // The server list feeds the group form's picker.
    void loadServers();
    return state.subscribe(event => {
      if (event.type === 'options') void reload();
      if (event.type !== 'group-run') return;
      const progress = event as unknown as GroupRunEvent;
      setRun(progress.state === 'done' || progress.state === 'failed' ? null : progress);
      if (progress.state === 'progress') setOutput(current => [...current, progress]);
      if (progress.state === 'started') setOutput([]);
    });
  }, [loadServers]);

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

  // Hosts that are already servers get no "add" button — the row would be an
  // invitation to create a duplicate.
  const configured = new Set(
    servers.map(server => server.host?.toLowerCase()).filter(Boolean));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Options" hint="Settings for this machine only." />

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-6">
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
            <Palette className="h-3.5 w-3.5" />
            Appearance
          </h2>
          <ThemePicker />
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
            <AlertTriangle className="h-3.5 w-3.5" />
            Alert thresholds
          </h2>
          <Thresholds />
        </section>

        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider uppercase">
              <Layers className="h-3.5 w-3.5" />
              Groups
              <span className="text-muted-foreground">({options.groups.length})</span>
            </h2>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              New group
            </Button>
          </div>

          {run && (
            <div className="mb-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs">
              Running on {run.group} — {run.done ?? 0} of {run.total ?? 0}
              {run.server && <span className="ml-2 font-mono">{run.server}</span>}
            </div>
          )}
          {output.length > 0 && (
            <div className="mb-3 overflow-hidden rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
                <span className="text-xs font-medium">Results</span>
                <span className="text-[10px] text-muted-foreground">
                  {output.filter(e => e.code === 0).length} of {output.length} succeeded
                </span>
                <button className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => setOutput([])}>
                  clear
                </button>
              </div>
              <div className="max-h-64 overflow-auto">
              {output.map((entry, index) => (
                <div key={index} className="border-b border-border-subtle p-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{entry.server}</span>
                    <Badge variant={entry.code === 0 ? 'outline' : 'destructive'}>exit {entry.code}</Badge>
                  </div>
                  {(entry.stdout || entry.stderr) && (
                    <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                      {entry.stdout}{entry.stderr}
                    </pre>
                  )}
                </div>
              ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {options.groups.map(group => (
              <div key={group.name} className="group/card rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{group.name}</span>
                  {group.dynamic && <Badge variant="secondary">dynamic</Badge>}
                  {group.fromConfig && <Badge variant="outline">from config</Badge>}
                  <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100">
                    <Button
                      variant="ghost" size="icon" aria-label={`Run a command on ${group.name}`}
                      disabled={group.serverCount === 0 || Boolean(run)}
                      onClick={() => {
                        const command = window.prompt(`Run on ${group.serverCount} server(s) in "${group.name}"`);
                        if (command?.trim()) void groupsApi.run(group.name, command);
                      }}
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                    {/* A config-derived group follows the servers' own field;
                        editing it here would create a copy that stops
                        following it. */}
                    {!group.dynamic && (
                      <>
                        <Button variant="ghost" size="icon" aria-label={`Edit ${group.name}`}
                          onClick={() => setEditing(group)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" aria-label={`Delete ${group.name}`}
                          onClick={async () => {
                            if (!window.confirm(`Delete the group "${group.name}"? The servers are untouched.`)) return;
                            try {
                              await groupsApi.remove(group.name);
                              void reload();
                            } catch (e) {
                              window.alert((e as Error).message);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">{group.serverCount}</span>
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
                  {/* A known host is a machine you have already connected to.
                      Offering to configure it here saves retyping an address
                      the application is looking at — and answers the obvious
                      question this list otherwise raises, which is why these
                      are not in Servers. */}
                  {!configured.has(entry.host.toLowerCase()) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => {
                        setServerDraft({ host: entry.host, port: entry.port });
                        setView('servers');
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add as a server
                    </Button>
                  )}
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

      {(creating || editing) && (
        <GroupDialog
          group={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
}
