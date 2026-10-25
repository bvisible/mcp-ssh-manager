/**
 * Which ssh-manager each AI tool starts, and the switch between the two there
 * can be: the one installed with npm, and the one inside the desktop
 * application. The same screen serves both kinds of user — whoever installed
 * with npm sees which version each tool really runs; whoever has only the app
 * connects their tools to it here, with no Node and no terminal.
 *
 * Nothing changes until a button is pressed, and a button changes one entry in
 * one tool's settings. The tool reads it when it next starts.
 */
import { useEffect, useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { agents, state, type AgentClient, type AgentEngine } from '@/lib/api';

type Status = Awaited<ReturnType<typeof agents.status>>;

const ENGINE_NAMES: Record<AgentEngine['kind'], string> = { app: 'the desktop app', npm: 'npm' };

function describe(client: AgentClient) {
  if (!client.installed) return 'Not found on this machine';
  const version = client.version ? ` ${client.version}` : '';
  if (client.engine === 'app') return `Runs the desktop app's engine${version}`;
  if (client.engine === 'npm') return `Runs the npm engine${version}`;
  if (client.engine === 'other') return 'Runs another ssh-manager (a checkout or a custom command)';
  return 'No ssh-manager entry yet';
}

function restartHint(client: AgentClient) {
  return client.id === 'claude-code'
    ? 'Start a new Claude Code session for it to take effect.'
    : `Restart ${client.name} for it to take effect.`;
}

export function AgentsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void agents.status()
        .then(value => { if (!cancelled) { setStatus(value); setError(null); } })
        .catch(cause => { if (!cancelled) setError((cause as Error).message); });
    };
    reload();
    const unsubscribe = state.subscribe(event => { if (event.type === 'agents') reload(); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  if (!status) {
    return error
      ? <p className="text-sm text-destructive">{error}</p>
      : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  }

  const use = async (client: AgentClient, kind: AgentEngine['kind']) => {
    setPending(`${client.id}:${kind}`);
    setError(null);
    setDone(null);
    try {
      const { client: updated } = await agents.use(client.id, kind);
      setStatus(current => current && { ...current, clients: current.clients.map(item => (item.id === updated.id ? updated : item)) });
      setDone({ id: client.id, message: `${client.name} now uses ${ENGINE_NAMES[kind]}. ${restartHint(client)}` });
    } catch (cause) {
      setError(`${client.name}: ${(cause as Error).message}`);
    } finally {
      setPending(null);
    }
  };

  const engines = [status.engines.app, status.engines.npm] as const;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Bot aria-hidden="true" className="h-4 w-4 text-primary" />
          Which ssh-manager your AI tools start
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          An AI tool starts ssh-manager itself, from the command in its settings. It can be the one
          installed with npm or the one inside the desktop app — the same engine either way; the app's
          needs no Node. Changing it rewrites that one entry and nothing else.
        </p>
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {(['app', 'npm'] as const).map((kind, index) => {
            const engine = engines[index];
            return (
              <div key={kind} className="rounded-md border border-border-subtle px-3 py-2">
                <dt className="font-medium">{kind === 'app' ? 'Desktop app' : 'npm'}</dt>
                <dd className="mt-0.5 text-muted-foreground">
                  {engine
                    ? `${engine.version ?? 'unknown version'}`
                    : kind === 'app' ? 'Not installed here' : 'Not installed with npm'}
                </dd>
                {engine && <dd className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={engine.args[0]}>{engine.args[0]}</dd>}
              </div>
            );
          })}
        </dl>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}

      <ul className="overflow-hidden rounded-lg border border-border" aria-label="AI tools">
        {status.clients.map(client => (
          <li key={client.id} className="border-b border-border-subtle px-4 py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{client.name}</p>
                <p className="text-xs text-muted-foreground">{describe(client)}</p>
                {client.installed && (
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={client.configPath}>{client.configPath}</p>
                )}
              </div>
              {client.installed && (['app', 'npm'] as const).map(kind => {
                const available = kind === 'app' ? status.engines.app : status.engines.npm;
                if (!available) return null;
                const current = client.engine === kind;
                const busy = pending === `${client.id}:${kind}`;
                return (
                  <Button
                    key={kind}
                    size="sm"
                    variant={current ? 'secondary' : 'outline'}
                    disabled={current || pending !== null}
                    aria-label={`${client.name}: use ${ENGINE_NAMES[kind]}`}
                    onClick={() => void use(client, kind)}
                  >
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {current ? `Using ${kind === 'app' ? 'the app' : 'npm'}` : `Use ${kind === 'app' ? 'the app' : 'npm'}`}
                  </Button>
                );
              })}
            </div>
            {done?.id === client.id && <p role="status" className="mt-2 text-xs text-primary">{done.message}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
