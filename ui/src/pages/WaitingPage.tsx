/**
 * The approval queue: what an agent wants to do, and your answer.
 *
 * This is the screen the whole control plane exists for. Everything else tells
 * you what happened; this one is the moment you can still change it, so the
 * command is shown in full, unwrapped and monospaced, and the two buttons say
 * what they do rather than "OK" and "Cancel".
 *
 * A destructive request says so in words across the card, and its approve
 * button is red and reads "Approve and run": the decision that cannot be undone
 * should not look like the one that can.
 */
import { useState } from 'react';
import { AlertTriangle, Check, Clock, Copy, ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { state } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/layout/EmptyState';
import { useWorkspace } from '@/stores/workspace';
import { usePendingRequests } from '@/lib/use-pending';
import { cn } from '@/lib/utils';

/** Seconds up to a minute, then minutes — nobody needs "waiting 143 s". */
function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const MODE_LABEL = { readonly: 'read only', restricted: 'restricted', unrestricted: 'unrestricted' } as const;

export function WaitingPage() {
  const setView = useWorkspace(state => state.setView);
  const { pending, drop } = usePendingRequests();
  const [deciding, setDeciding] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const decide = async (id: string, approved: boolean) => {
    setDeciding(id);
    try {
      await state.decide(id, approved);
      drop(id);
    } finally {
      setDeciding(null);
    }
  };

  const copy = async (id: string, command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(id);
      setTimeout(() => setCopied(current => (current === id ? null : current)), 1500);
    } catch {
      /* the command is on screen in full; a failed copy costs nothing */
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The header stays even with nothing in the queue. Returning only the
          empty state, as this used to, made the screen look like a different
          application from the one next to it in the rail. */}
      <PageHeader
        title="Waiting"
        count={pending.length}
        hint="An agent paused on these commands. Nothing runs until you decide."
      />

      {pending.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="Nothing is waiting"
          // This screen used to explain where approval is configured and then
          // leave you to find it. Saying "it is set on the server" to somebody
          // looking at an empty queue is an instruction with no door attached.
          hint="Nothing pauses here until you ask it to. Open a server, set Approval to destructive or always, and its agent will stop and wait for you before acting."
          action={
            <Button size="sm" onClick={() => setView('servers')}>
              <ShieldCheck className="h-3.5 w-3.5" />
              Set it up on a server
            </Button>
          }
        />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-6">
        <div className="flex max-w-5xl flex-col gap-4">
        {pending.map(request => (
          <article key={request.id} className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3.5">
              <h2 className="text-base font-bold">{request.server}</h2>
              <span className="font-mono text-[12.5px] text-muted-foreground">
                {request.user}@{request.host}
              </span>
              <span className="inline-flex h-6 items-center rounded-md border border-border px-2 font-mono text-xs text-muted-foreground">
                {request.tool}
              </span>
              {request.mode !== 'unrestricted' && (
                <span className="inline-flex h-6 items-center rounded-md bg-secondary px-2 text-xs text-secondary-foreground">
                  {MODE_LABEL[request.mode]}
                </span>
              )}
              {/* How long an agent has been blocked is the number that decides
                  whether you answer now or finish your sentence first. */}
              <span className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-muted-foreground tabular-nums">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                waiting {formatWait(request.waitingMs)}
              </span>
            </div>

            {request.destructive && (
              <div className="flex items-start gap-2.5 bg-destructive-light px-5 py-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p><b>Destructive.</b> This command can delete or overwrite data, and nothing on the server will undo it.</p>
              </div>
            )}

            {/* Wrapped, not truncated: half a command is how you approve the
                wrong thing. */}
            <div className="px-5 py-4">
              <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary py-3 pl-4 pr-2">
                <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[14.5px] leading-relaxed">
                  {request.command || '(no command)'}
                </pre>
                {request.command && (
                  <button
                    type="button"
                    aria-label={copied === request.id ? 'Copied' : 'Copy the command'}
                    title={copied === request.id ? 'Copied' : 'Copy the command'}
                    onClick={() => void copy(request.id, request.command!)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                  >
                    {copied === request.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2.5 px-5 pb-4">
              <Button
                variant="outline"
                className="h-11 px-5 font-bold"
                disabled={deciding === request.id}
                onClick={() => void decide(request.id, false)}
              >
                <X className="h-4 w-4" />
                Refuse
              </Button>
              <Button
                variant={request.destructive ? 'destructive' : 'default'}
                className={cn('h-11 px-5 font-bold')}
                disabled={deciding === request.id}
                onClick={() => void decide(request.id, true)}
              >
                <Check className="h-4 w-4" />
                {request.destructive ? 'Approve and run' : 'Approve'}
              </Button>
            </div>
          </article>
        ))}
        </div>
      </div>
      )}
    </div>
  );
}
