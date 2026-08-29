/**
 * Server health, probed when you ask and never on a timer.
 *
 * That is a deliberate policy, not a missing feature: every probe is an SSH
 * handshake, and a dashboard that connects to every production box on a
 * schedule is worse than no dashboard — it is a machine quietly opening
 * sessions nobody asked for. The button is the whole scheduling policy.
 */
import { useState } from 'react';
import { HeartPulse, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { health, type HealthResult } from '@/lib/api';

/** Amber past 80%, red past 90% — the thresholds an operator already has in mind. */
function severity(percent: number): string {
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 80) return 'bg-warning';
  return 'bg-success';
}

function Gauge({ label, percent, detail }: { label: string; percent?: number; detail?: string }) {
  if (percent === undefined) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{clamped}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunk">
        <div className={cn('h-full rounded-full transition-[width]', severity(clamped))}
          style={{ width: `${clamped}%` }} />
      </div>
      {detail && <p className="text-[10px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function HealthPage() {
  const [results, setResults] = useState<HealthResult[] | null>(null);
  const [probing, setProbing] = useState(false);

  const probe = async (server?: string) => {
    setProbing(true);
    try {
      const answer = await health.check(server);
      setResults(current =>
        server && current
          ? current.map(r => answer.results.find(a => a.server === r.server) ?? r)
          : answer.results
      );
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">Health</h1>
        <p className="text-xs text-muted-foreground">Probed on demand — nothing runs in the background.</p>
        <Button size="sm" className="ml-auto" disabled={probing} onClick={() => void probe()}>
          {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Check every server
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {results === null ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
              <HeartPulse className="h-7 w-7 text-accent" />
            </div>
            <p className="text-sm font-medium">Nothing probed yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Each check opens one SSH connection and closes it. Press the button when you want to know.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {results.map(result => (
              <article key={result.server} className="rounded-lg border border-border bg-card p-4 shadow-card">
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-sm font-medium">{result.server}</span>
                  <Badge variant={result.reachable ? 'secondary' : 'destructive'}>
                    {result.reachable ? 'reachable' : 'unreachable'}
                  </Badge>
                  <button
                    className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => void probe(result.server)}
                  >
                    recheck
                  </button>
                </div>

                {result.reachable ? (
                  <div className="grid gap-3">
                    <Gauge label="CPU" percent={result.cpu?.percent}
                      detail={result.load_average ? `load ${result.load_average}` : undefined} />
                    <Gauge label="Memory" percent={result.memory?.percent}
                      detail={result.memory?.used_mb !== undefined && result.memory.total_mb !== undefined
                        ? `${Math.round(result.memory.used_mb / 1024)} of ${Math.round(result.memory.total_mb / 1024)} GB`
                        : undefined} />
                    {/* Every mount, not the first two: the one that fills up is
                        never the one you were watching. */}
                    {result.disks?.map(disk => (
                      <Gauge key={disk.mount} label={disk.mount} percent={disk.percent}
                        detail={`${disk.used} of ${disk.size}, ${disk.avail} free`} />
                    ))}
                    <p className="text-[10px] text-muted-foreground">
                      {/* uptime already reads "up 42 days" — prefixing it again
                          is how you get "up up 42 days". */}
                      {result.uptime}
                      {` · answered in ${result.tookMs} ms`}
                    </p>
                  </div>
                ) : (
                  // Unreachable is a legitimate answer, not an error: it is
                  // exactly what the operator wants to see.
                  <p className="text-xs text-muted-foreground">
                    {result.error ?? 'No answer'} — {result.host}, gave up after {result.tookMs} ms
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
