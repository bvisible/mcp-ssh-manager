/**
 * Server health, probed when you ask and never on a timer.
 *
 * That is a deliberate policy, not a missing feature: every probe is an SSH
 * handshake, and a dashboard that connects to every production box on a
 * schedule is worse than no dashboard — it is a machine quietly opening
 * sessions nobody asked for. The button is the whole scheduling policy.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, HeartPulse, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { health, thresholds as thresholdsApi, type HealthResult, type Thresholds } from '@/lib/api';
import { ensurePermission } from '@/lib/notify';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';

/**
 * Amber at the threshold, red ten points past it, and graphite below: a card of
 * green bars said "fine" so loudly that the one amber bar was what you missed.
 * The threshold is the operator's, not a constant baked into a gauge — a disk
 * that is meant to sit at 88% should not be permanently amber.
 */
function severity(percent: number, threshold: number): 'over' | 'near' | 'ok' {
  if (percent >= threshold + 10) return 'over';
  if (percent >= threshold) return 'near';
  return 'ok';
}

const BAR = { over: 'bg-destructive', near: 'bg-warning', ok: 'bg-meter' } as const;
const TEXT = { over: 'text-destructive', near: 'text-warning', ok: '' } as const;

function Gauge({ label, percent, detail, threshold, mono }:
  { label: string; percent?: number; detail?: string; threshold: number; mono?: boolean }) {
  if (percent === undefined) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const level = severity(clamped, threshold);
  return (
    <div className="grid gap-1.5">
      <div className={cn('flex items-baseline justify-between gap-3 text-[13px]', TEXT[level])}>
        <span className={cn('min-w-0 truncate', mono && 'font-mono', level !== 'ok' && 'font-bold')}>{label}</span>
        <span className="font-bold tabular-nums">{clamped}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunk">
        <div className={cn('h-full rounded-full transition-[width]', BAR[level])}
          style={{ width: `${clamped}%` }} />
      </div>
      {detail && (
        <p className="text-xs text-muted-foreground">
          {detail}
          {level !== 'ok' && ` · over the ${threshold}% threshold`}
        </p>
      )}
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

  const reachable = results?.filter(r => r.reachable).length ?? 0;
  const warned = results?.filter(r => r.reachable && (r.alerts?.length ?? 0) > 0).length ?? 0;
  const unreachable = (results?.length ?? 0) - reachable;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Health"
        count={results?.length}
        hint="Probed when you ask. Nothing runs in the background."
        actions={
          <Button className="font-bold" disabled={probing} onClick={() => void probe()}>
            {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check every server
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pb-10 pt-5">
        {/* The verdict before the detail: three counts you can read from the
            door, then the cards that explain them. */}
        {results !== null && results.length > 0 && (
          <div className="mb-5 flex flex-wrap gap-2" aria-label="Summary">
            <span className="inline-flex h-8 items-center gap-2 rounded-full bg-success-light px-3 text-[13px] font-bold text-success">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              {reachable} reachable
            </span>
            {warned > 0 && (
              <span className="inline-flex h-8 items-center gap-2 rounded-full bg-warning-light px-3 text-[13px] font-bold text-warning">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {warned} over a threshold
              </span>
            )}
            {unreachable > 0 && (
              <span className="inline-flex h-8 items-center gap-2 rounded-full bg-destructive-light px-3 text-[13px] font-bold text-destructive">
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                {unreachable} unreachable
              </span>
            )}
          </div>
        )}
        {results === null ? (
          // Centred like every other empty screen. This one used to sit at the
          // top under a `py-20`, which read as a different page.
          <EmptyState
            icon={HeartPulse}
            title="Nothing probed yet"
            hint="Each check opens one SSH connection and closes it. Press the button when you want to know."
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {results.map(result => (
              <article key={result.server} className="flex flex-col rounded-xl border border-border bg-card">
                <div className="flex items-center gap-2.5 px-4 pb-3 pt-3.5">
                  <h2 className="min-w-0 truncate text-base font-bold">{result.server}</h2>
                  <span className={cn(
                    'inline-flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-bold',
                    result.reachable ? 'bg-success-light text-success' : 'bg-destructive-light text-destructive'
                  )}>
                    {result.reachable ? 'Reachable' : 'Unreachable'}
                  </span>
                  <button
                    type="button"
                    aria-label={`Recheck ${result.server}`}
                    title="Recheck"
                    disabled={probing}
                    className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                    onClick={() => void probe(result.server)}
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </div>

                {result.reachable ? (
                  <div className="grid gap-3.5 px-4 pb-4">
                    {(result.alerts?.length ?? 0) > 0 && (
                      <div className="rounded-lg bg-warning-light px-3 py-2 text-warning">
                        {result.alerts!.map(alert => (
                          <p key={alert.type} className="flex items-start gap-1.5 text-xs font-medium">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
                      <Gauge key={disk.mount} label={disk.mount} mono percent={disk.percent} threshold={limits.disk}
                        detail={`${disk.used} of ${disk.size}, ${disk.avail} free`} />
                    ))}
                  </div>
                ) : (
                  // Unreachable is a legitimate answer, not an error: it is
                  // exactly what the operator wants to see.
                  <div className="px-4 pb-4">
                    <div className="rounded-lg border border-border bg-secondary px-3.5 py-3">
                      <p className="text-sm font-bold">{result.error ?? 'No answer'}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {result.host} · gave up after {result.tookMs} ms
                      </p>
                    </div>
                  </div>
                )}

                <p className="mt-auto border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                  {/* uptime already reads "up 42 days" — prefixing it again is
                      how you get "up up 42 days". */}
                  {result.reachable
                    ? <>{result.uptime}{` · answered in ${result.tookMs} ms`}</>
                    : 'Recheck once the host or the network is back.'}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
