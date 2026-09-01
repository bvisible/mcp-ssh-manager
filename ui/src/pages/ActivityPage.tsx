/**
 * The audit trail: what was done, by whom, and what you answered.
 *
 * Approvals always land here. Everything else only does when a server has
 * `AUDIT_LOG` set — which is worth saying on the screen rather than leaving the
 * operator to conclude their agents did nothing.
 */
import { useEffect, useState } from 'react';
import { Activity, Check, ChevronDown, ChevronRight, Info, Terminal, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { state, history as historyApi, type TimelineEntry, type CommandLogEntry } from '@/lib/api';
import { TerminalOutput } from '@/components/terminal/TerminalOutput';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';

type Tab = 'commands' | 'decisions';

export function ActivityPage() {
  const [tab, setTab] = useState<Tab>('commands');
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [commands, setCommands] = useState<CommandLogEntry[]>([]);
  const [recordsOutput, setRecordsOutput] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // What agents ran, from the control plane's own log — nothing to configure on
  // the servers, because every command already passes through here.
  useEffect(() => {
    const refresh = () =>
      historyApi
        .get()
        .then(result => { setCommands(result.entries); setRecordsOutput(result.recordsOutput); })
        .catch(() => {});
    void refresh();
    return state.subscribe(event => {
      if (event.type === 'stream') void refresh();
    });
  }, []);

  useEffect(() => {
    void state.get().then(s => setTimeline(s.timeline)).catch(() => {});
    return state.subscribe(event => {
      if (event.type === 'timeline' && event.entry) {
        // Newest first, and appended rather than refetched: the whole point of
        // a push channel is not going back to ask.
        setTimeline(current => [event.entry as TimelineEntry, ...current].slice(0, 500));
      }
    });
  }, []);

  const header = (
    <PageHeader title="Activity" hint="What your agents ran, and what you decided.">
      {([['commands', 'Commands', commands.length], ['decisions', 'Decisions', timeline.length]] as const)
        .map(([id, label, count], at) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={at > 0 ? { marginLeft: '0.25rem' } : undefined}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              tab === id ? 'bg-accent text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
            {count > 0 && <span className="ml-1 text-[10px] text-muted-foreground">{count}</span>}
          </button>
        ))}
      {tab === 'commands' && commands.length > 0 && (
        <button
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
          onClick={async () => {
            if (!window.confirm('Clear the command history on this machine?')) return;
            await historyApi.clear();
            setCommands([]);
          }}
        >
          clear
        </button>
      )}
    </PageHeader>
  );

  if (tab === 'commands') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {commands.length === 0 ? (
          <EmptyState
            icon={Terminal}
            title="No command recorded yet"
            hint={'Everything your agents run is written down here, on this machine — nothing to configure on the servers.'
              + (recordsOutput ? '' : ' Output is not kept; set SSH_MANAGER_LOG_OUTPUT=1 if you want it.')}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ol>
              {commands.map((entry, index) => {
                const key = `${entry.ts}-${index}`;
                const open = expanded === key;
                return (
                  <li key={key} className="border-b border-border-subtle">
                    <button
                      onClick={() => setExpanded(open ? null : key)}
                      disabled={!entry.output}
                      className="flex w-full items-start gap-2 px-6 py-2.5 text-left hover:bg-card-hover disabled:cursor-default"
                    >
                      {entry.output
                        ? (open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />)
                        : <span className="w-3.5" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium">{entry.server}</span>
                          <Badge variant={entry.code === 0 ? 'outline' : 'destructive'}>
                            exit {entry.code ?? '—'}
                          </Badge>
                          {entry.durationMs !== undefined && (
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {entry.durationMs < 1000
                                ? `${entry.durationMs} ms`
                                : `${(entry.durationMs / 1000).toFixed(1)} s`}
                            </span>
                          )}
                        </div>
                        <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {entry.command}
                        </code>
                      </div>
                      <time className="shrink-0 text-[10px] text-muted-foreground tabular-nums" dateTime={entry.ts}>
                        {new Date(entry.ts).toLocaleString()}
                      </time>
                    </button>
                    {open && entry.output && <TerminalOutput content={entry.output} rows={12} />}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    );
  }

  if (timeline.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        {(
      <EmptyState
        icon={Activity}
        title="Nothing recorded yet"
        hint="Every approval you granted or refused appears here. What agents ran is under Commands."
      />
    )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ol>
          {timeline.map((entry, index) => {
            const decided = entry.allowed !== undefined;
            const Icon = !decided ? Info : entry.allowed ? Check : X;
            return (
              <li
                key={`${entry.ts}-${index}`}
                className="flex gap-3 border-b border-border-subtle px-6 py-2.5 hover:bg-card-hover"
              >
                <Icon
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    !decided ? 'text-muted-foreground' : entry.allowed ? 'text-success' : 'text-destructive'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">{entry.server ?? '—'}</span>
                    {entry.tool && <Badge variant="outline">{entry.tool}</Badge>}
                    {decided && (
                      <span className="text-[10px] text-muted-foreground">
                        {entry.allowed ? 'approved' : 'refused'}
                        {entry.source && ` · ${entry.source}`}
                      </span>
                    )}
                  </div>
                  {entry.command && (
                    <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {entry.command}
                    </code>
                  )}
                  {/* "approval deny" would just repeat the badge above it; a
                      reason someone typed is worth showing. */}
                  {entry.reason && !/^approval (allow|deny)$/.test(entry.reason) && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{entry.reason}</p>
                  )}
                </div>
                <time className="shrink-0 text-[10px] text-muted-foreground tabular-nums" dateTime={entry.ts}>
                  {new Date(entry.ts).toLocaleTimeString()}
                </time>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
