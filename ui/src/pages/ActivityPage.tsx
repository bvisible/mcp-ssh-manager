/**
 * The audit trail: what was done, by whom, and what you answered.
 *
 * Approvals always land here. Everything else only does when a server has
 * `AUDIT_LOG` set — which is worth saying on the screen rather than leaving the
 * operator to conclude their agents did nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { Activity, Check, ChevronDown, ChevronRight, Info, Terminal, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { state, history as historyApi, type TimelineEntry, type CommandLogEntry } from '@/lib/api';
import { TerminalOutput } from '@/components/terminal/TerminalOutput';
import { CommandBlock } from '@/components/CommandBlock';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';
import { tr, useLocale } from '@/lib/i18n';

type Tab = 'commands' | 'decisions';

type Entry = { ts: string; server?: string; command?: string };

/**
 * A key per entry that does not depend on its position, used both as the React
 * key and to remember which entries are open.
 *
 * Both lists gain entries at the top while you read them (a refetch per
 * finished command, a push per decision). A key with the index in it changed
 * for every row each time, so React rebuilt them all: an open entry lost the
 * text being selected in it, and its terminal was torn down and redrawn.
 *
 * Time, server and command are not unique on their own (two identical commands
 * can end in the same millisecond; an audit line may have no command at all),
 * so repeats are numbered, counting from the oldest end: entries arrive at the
 * other one, which leaves every number already given where it was.
 */
function entryKeys(entries: Entry[], prefix: string): string[] {
  const seen = new Map<string, number>();
  const keys = new Array<string>(entries.length);
  for (let at = entries.length - 1; at >= 0; at--) {
    const { ts, server = '', command = '' } = entries[at];
    const base = `${prefix}|${ts}|${server}|${command}`;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    keys[at] = repeat ? `${base}|${repeat}` : base;
  }
  return keys;
}

export function ActivityPage() {
  useLocale();
  const [tab, setTab] = useState<Tab>('commands');
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [commands, setCommands] = useState<CommandLogEntry[]>([]);
  const [recordsOutput, setRecordsOutput] = useState(false);
  // Any number open at once, as on the Live page: comparing two commands is
  // a reason to open them.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const commandKeys = useMemo(() => entryKeys(commands, 'command'), [commands]);
  const decisionKeys = useMemo(() => entryKeys(timeline, 'decision'), [timeline]);

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
    <PageHeader title={tr("Activity")} hint={tr("What your agents ran, and what you decided.")}>
      {([['commands', tr("Commands"), commands.length], ['decisions', tr("Decisions"), timeline.length]] as const)
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
            if (!window.confirm(tr("Clear the command history on this machine?"))) return;
            await historyApi.clear();
            setCommands([]);
          }}
        >{tr("clear")}</button>
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
            title={tr("No command recorded yet")}
            hint={tr("Everything your agents run is written down here, on this machine — nothing to configure on the servers.")
              + (recordsOutput ? '' : ' ' + tr('Output is not kept; set SSH_MANAGER_LOG_OUTPUT=1 if you want it.'))}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ol>
              {commands.map((entry, index) => {
                const key = commandKeys[index];
                const open = expanded.has(key);
                return (
                  <li key={key} className="border-b border-border-subtle">
                    <button
                      onClick={() => toggle(key)}
                      aria-expanded={open}
                      className="flex w-full items-start gap-2 px-6 py-2.5 text-left hover:bg-card-hover"
                    >
                      {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium">{entry.server}</span>
                          <Badge variant={entry.code === 0 ? 'outline' : 'destructive'}>
                            {tr("exit")} {entry.code ?? '—'}
                          </Badge>
                          {entry.durationMs !== undefined && (
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {entry.durationMs < 1000
                                ? `${entry.durationMs} ms`
                                : `${(entry.durationMs / 1000).toFixed(1)} s`}
                            </span>
                          )}
                        </div>
                        <code title={entry.command} className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {entry.command}
                        </code>
                      </div>
                      <time className="shrink-0 text-[10px] text-muted-foreground tabular-nums" dateTime={entry.ts}>
                        {new Date(entry.ts).toLocaleString()}
                      </time>
                    </button>
                    {/* Every entry opens, output or not: output is only kept
                        with SSH_MANAGER_LOG_OUTPUT=1, and the command is worth
                        reading in full either way. Outside the toggle, as on the
                        Live page, so a click to select it does not close it. */}
                    {open && (
                      <>
                        <CommandBlock command={entry.command} size="compact" className="border-t border-border-subtle py-1 pl-6 pr-4" />
                        {entry.output && <TerminalOutput content={entry.output} rows={12} />}
                      </>
                    )}
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
        title={tr("Nothing recorded yet")}
        hint={tr("Every approval you granted or refused appears here. What agents ran is under Commands.")}
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
            const key = decisionKeys[index];
            const open = expanded.has(key);
            const rowClass = 'flex w-full gap-3 px-6 py-2.5 text-left hover:bg-card-hover';
            const row = (
              <>
                <span className="mt-0.5 flex shrink-0 items-center gap-1.5">
                  {!entry.command ? <span className="w-3.5" />
                    : open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <Icon
                    className={cn(
                      'h-3.5 w-3.5',
                      !decided ? 'text-muted-foreground' : entry.allowed ? 'text-success' : 'text-destructive'
                    )}
                  />
                </span>
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
                    <code title={entry.command} className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
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
              </>
            );
            // Only an entry with a command has anything more to show.
            return (
              <li key={key} className="border-b border-border-subtle">
                {entry.command ? (
                  <button onClick={() => toggle(key)} aria-expanded={open} className={rowClass}>
                    {row}
                  </button>
                ) : (
                  <div className={rowClass}>{row}</div>
                )}
                {open && entry.command && (
                  <CommandBlock command={entry.command} size="compact" className="border-t border-border-subtle py-1 pl-6 pr-4" />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
