/**
 * Whether this page is still talking to the control plane.
 *
 * Two pieces. The badge at the foot of the rail is the live status, always
 * there and announced to assistive technology; when everything is fine it is
 * a green dot and a few words, which is all "fine" deserves. The banner across
 * the top of the page appears only when it is not fine, because a screen of
 * stale data that looks current is worse than an empty one.
 */
import { useEffect, useState } from 'react';
import { Loader2, Unplug } from 'lucide-react';
import { state } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/stores/workspace';

function useConnection(): string {
  const [status, setStatus] = useState('connecting');
  useEffect(() => state.subscribe(event => {
    if (event.type === 'connection') setStatus(String(event.status));
  }), []);
  return status;
}

function describe(status: string): string {
  return status === 'connected' ? 'Control plane connected'
    : status === 'connecting' ? 'Connecting to the control plane…'
      : 'Connection lost. Reconnecting — displayed activity may be out of date.';
}

export function ConnectionBadge({ expanded }: { expanded: boolean }) {
  const handedOver = useWorkspace(s => s.handedOver);
  const live = useConnection();
  // After a hand-over the plane stops on purpose; "connection lost" would be
  // the wrong thing to announce.
  const status = handedOver && live !== 'connected' ? 'connected' : live;
  const connected = status === 'connected';
  return (
    <div
      role="status"
      aria-live="polite"
      title={describe(status)}
      className={cn(
        'flex items-center gap-2 rounded-lg text-xs',
        expanded ? 'border border-sidebar-border bg-card px-3 py-2.5' : 'justify-center py-2'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          connected ? 'bg-success' : status === 'connecting' ? 'bg-muted-foreground' : 'bg-warning'
        )}
      />
      {/* The full sentence stays in the DOM when the rail is collapsed: it is
          what a screen reader announces when the connection drops. */}
      <span className={cn('min-w-0 truncate font-bold', !expanded && 'sr-only')}>
        {connected ? 'Control plane connected' : status === 'connecting' ? 'Connecting…' : 'Connection lost'}
        <span className="sr-only">{connected ? '' : ` — ${describe(status)}`}</span>
      </span>
    </div>
  );
}

export function ConnectionBanner() {
  const status = useConnection();
  // Stopping after handing over to the desktop application is the plan, not a
  // fault: the page already says it continued there.
  const handedOver = useWorkspace(s => s.handedOver);
  if (status === 'connected' || handedOver) return null;
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-6 py-2 text-sm',
        status === 'disconnected' ? 'border-warning/30 bg-warning-light text-foreground' : 'border-border bg-muted text-muted-foreground'
      )}
    >
      {status === 'connecting'
        ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <Unplug className="h-4 w-4 text-warning" aria-hidden="true" />}
      {describe(status)}
    </div>
  );
}
