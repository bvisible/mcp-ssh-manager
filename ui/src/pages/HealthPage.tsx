/**
 * Server health, probed when you ask and never on a timer.
 *
 * That is a deliberate policy, not a missing feature: every probe is an SSH
 * handshake, and a dashboard that connects to every production box on a
 * schedule is worse than no dashboard — it is a machine quietly opening
 * sessions nobody asked for. The button is the whole scheduling policy.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, HeartPulse, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { health, thresholds as thresholdsApi, type HealthResult, type Thresholds } from '@/lib/api';
import { ensurePermission } from '@/lib/notify';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';

/**
 * Amber at the threshold, red ten points past it. The threshold is the
 * operator's, not a constant baked into a gauge — a disk that is meant to sit
 * at 88% should not be permanently amber.
 */
function severity(percent: number, threshold: number): string {
  if (percent >= threshold + 10) return 'bg-destructive';
  if (percent >= threshold) return 'bg-warning';
  return 'bg-success';
}

function Gauge({ label, percent, detail, threshold }:
  { label: string; percent?: number; detail?: string; threshold: number }) {
  if (percent === undefined) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{clamped}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunk">
        <div className={cn('h-full rounded-full transition-[width]', severity(clamped, threshold))}
          style={{ width: `${clamped}%` }} />
      </div>
      {detail && <p className="text-[10px] text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function HealthPage() {
  const [results, setResults] = useState<HealthResult[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [limits, setLimits] = useState<Thresholds>({ cpu: 80, memory: 90, disk: 85, enabled: true });

  useEffect(() => {
    void thresholdsApi.get().then(r => setLimits(r.thresholds)).catch(() => {});
  }, []);

  const probe = async (server?: string) => {
    setProbing(true);
    try {
      const answer = await health.check(server);
      setResults(current =>
        server && current
          ? current.map(r => answer.results.find(a => a.server === r.server) ?? r)
          : answer.results
      );

      // A probe you ran while looking at the screen needs no notification. One
      // that crosses a threshold does, because the next thing you do is walk
      // away — and the disk does not stop filling.
      const crossed = answer.results.filter(r => (r.alerts?.length ?? 0) > 0);
      if (crossed.length > 0 && await ensurePermission()) {
        for (const machine of crossed) {
          new Notification(`${machine.server}: ${machine.alerts![0].type} over threshold`, {
            body: machine.alerts!.map(a => a.message).join('\n'),
            tag: `health:${machine.server}`,
          });
        }
      }
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Health"
        count={results?.length}
        hint="Probed on demand — nothing runs in the background."
        actions={
          <Button size="sm" disabled={probing} onClick={() => void probe()}>
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check every server
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {results === null ? (
          // Centred like every other empty screen. This one used to sit at the
          // top under a `py-20`, which read as a different page.
          <EmptyState
            icon={HeartPulse}
            title="Nothing probed yet"
            hint="Each check opens one SSH connection and closes it. Press the button when you want to know."
          />
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
                    {(result.alerts?.length ?? 0) > 0 && (
                      <div className="rounded-md border border-warning/40 bg-warning-light px-2 py-1.5">
                        {result.alerts!.map(alert => (
                          <p key={alert.type} className="flex items-start gap-1.5 text-[11px]">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                            {alert.message}
                          </p>
                        ))}
                      </div>
                    )}
                    <Gauge label="CPU" percent={result.cpu?.percent} threshold={limits.cpu}
                      detail={result.load_average ? `load ${result.load_average}` : undefined} />
                    <Gauge label="Memory" percent={result.memory?.percent} threshold={limits.memory}
                      detail={result.memory?.used_mb !== undefined && result.memory.total_mb !== undefined
                        ? `${Math.round(result.memory.used_mb / 1024)} of ${Math.round(result.memory.total_mb / 1024)} GB`
                        : undefined} />
                    {/* Every mount, not the first two: the one that fills up is
                        never the one you were watching. */}
                    {result.disks?.map(disk => (
                      <Gauge key={disk.mount} label={disk.mount} percent={disk.percent} threshold={limits.disk}
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
