/**
 * The approval queue: what an agent wants to do, and your answer.
 *
 * This is the screen the whole control plane exists for. Everything else tells
 * you what happened; this one is the moment you can still change it, so the
 * command is shown in full, unwrapped and monospaced, and the two buttons say
 * what they do rather than "OK" and "Cancel".
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { state, QUEUE_EVENTS, type PendingRequest } from '@/lib/api';

/** Seconds up to a minute, then minutes — nobody needs "waiting 143 s". */
function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function WaitingPage() {
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => state.get().then(s => setPending(s.pending)).catch(() => {});
    void refresh();
    // Pushed rather than polled: a request that waits on a timer is a request
    // whose answer arrives late, and the agent is blocked meanwhile.
    return state.subscribe(event => {
      if ((QUEUE_EVENTS as readonly string[]).includes(event.type)) void refresh();
    });
  }, []);

  const decide = async (id: string, approved: boolean) => {
    setDeciding(id);
    try {
      await state.decide(id, approved);
      setPending(current => current.filter(r => r.id !== id));
    } finally {
      setDeciding(null);
    }
  };

  if (pending.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10">
          <Clock className="h-7 w-7 text-accent" />
        </div>
        <p className="text-sm font-medium">Nothing is waiting</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Servers set to <code className="font-mono">APPROVAL=destructive</code> or{' '}
          <code className="font-mono">=always</code> pause here before acting.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-3">
        <h1 className="text-sm font-medium">
          Waiting <span className="ml-1 text-muted-foreground">({pending.length})</span>
        </h1>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
        {pending.map(request => (
          <article key={request.id} className="rounded-lg border border-border bg-card shadow-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2.5">
              <span className="text-sm font-medium">{request.server}</span>
              <span className="text-xs text-muted-foreground">
                {request.user}@{request.host}
              </span>
              <Badge variant="outline" className="ml-1">{request.tool}</Badge>
              {request.mode !== 'unrestricted' && <Badge variant="secondary">{request.mode}</Badge>}
              {request.destructive && (
                <Badge variant="destructive" className="gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  destructive
                </Badge>
              )}
              {/* How long an agent has been blocked is the number that decides
                  whether you answer now or finish your sentence first. */}
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                waiting {formatWait(request.waitingMs)}
              </span>
            </div>

            {/* Wrapped, not truncated: half a command is how you approve the
                wrong thing. */}
            <pre className="overflow-x-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap">
              {request.command || '(no command)'}
            </pre>

            <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-2.5">
              <Button
                variant="outline"
                size="sm"
                disabled={deciding === request.id}
                onClick={() => void decide(request.id, false)}
              >
                <X className="h-3.5 w-3.5" />
                Refuse
              </Button>
              <Button
                size="sm"
                disabled={deciding === request.id}
                onClick={() => void decide(request.id, true)}
              >
                <Check className="h-3.5 w-3.5" />
                Approve
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
