/**
 * What your agents are running, while they run it.
 *
 * The product's best argument, so it gets the output and not just a status:
 * you see the command, and you see what it is printing, live. Each stream keeps
 * a bounded scrollback in the control plane, so opening this screen mid-command
 * shows what came before rather than starting blank.
 *
 * Nothing here is written to disk. A stream can contain secrets — a config
 * being catted, a token echoed by a deploy script — so it lives in memory,
 * capped, and disappears when the window closes. Only the command line itself
 * reaches the audit log.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Radio } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { state, type LiveStream } from '@/lib/api';

export function LivePage() {
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const refresh = () => state.streams().then(s => setStreams(s.streams)).catch(() => {});
    void refresh();
    return state.subscribe(event => {
      if (event.type === 'stream') void refresh();
    });
  }, []);

  const { running, finished } = useMemo(
    () => ({
      running: streams.filter(s => s.code === null),
      finished: streams.filter(s => s.code !== null),
    }),
    [streams]
  );

  const toggle = (id: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (streams.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
          <Radio className="h-7 w-7 text-accent" />
        </div>
        <p className="text-sm font-medium">No command is running</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          When an agent runs something on one of your servers, it appears here as it happens —
          output included.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">Live</h1>
        {running.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            {running.length} running
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-6">
        {[...running, ...finished].map(stream => {
          const open = expanded.has(stream.id);
          return (
            <article key={stream.id} className="overflow-hidden rounded-lg border border-border bg-card">
              <button
                onClick={() => toggle(stream.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-card-hover"
              >
                {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                <span className="shrink-0 text-xs font-medium">{stream.server}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {stream.command}
                </code>
                {stream.code === null ? (
                  <Badge variant="secondary">running</Badge>
                ) : (
                  <Badge variant={stream.code === 0 ? 'outline' : 'destructive'}>
                    exit {stream.code}
                  </Badge>
                )}
              </button>

              {open && (
                <pre className={cn(
                  'max-h-80 overflow-auto border-t border-border-subtle bg-[#111418] px-3 py-2',
                  'font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#e6e8eb]'
                )}>
                  {stream.scrollback || '(no output yet)'}
                </pre>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
