/**
 * The audit trail: what was done, by whom, and what you answered.
 *
 * Approvals always land here. Everything else only does when a server has
 * `AUDIT_LOG` set — which is worth saying on the screen rather than leaving the
 * operator to conclude their agents did nothing.
 */
import { useEffect, useState } from 'react';
import { Activity, Check, Info, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { state, type TimelineEntry } from '@/lib/api';

export function ActivityPage() {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

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

  if (timeline.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
          <Activity className="h-7 w-7 text-accent" />
        </div>
        <p className="text-sm font-medium">Nothing recorded yet</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Approvals always appear here. To see everything else, set{' '}
          <code className="font-mono">SSH_SERVER_&lt;NAME&gt;_AUDIT_LOG</code> on a server.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">Activity</h1>
      </header>

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
