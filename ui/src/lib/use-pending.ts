/**
 * The approval queue, live.
 *
 * Shared by the Waiting screen and the banner on the Servers screen, so the two
 * can never disagree about what is waiting. Pushed rather than polled: a
 * request that waits on a timer is a request whose answer arrives late, and
 * the agent is blocked meanwhile.
 */
import { useCallback, useEffect, useState } from 'react';
import { state, QUEUE_EVENTS, type PendingRequest } from '@/lib/api';

export function usePendingRequests(): { pending: PendingRequest[]; drop: (id: string) => void } {
  const [pending, setPending] = useState<PendingRequest[]>([]);

  useEffect(() => {
    const refresh = () => state.get().then(s => setPending(s.pending)).catch(() => {});
    void refresh();
    return state.subscribe(event => {
      if ((QUEUE_EVENTS as readonly string[]).includes(event.type)) void refresh();
    });
  }, []);

  // Removed at once on an answer, before the queue event confirms it: a
  // decided request that lingers for a beat invites a second click.
  const drop = useCallback((id: string) => {
    setPending(current => current.filter(request => request.id !== id));
  }, []);

  return { pending, drop };
}
