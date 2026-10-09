import { useEffect, useState } from 'react';
import { CircleCheck, Loader2, Unplug } from 'lucide-react';
import { state } from '@/lib/api';

export function ConnectionStatus() {
  const [status, setStatus] = useState('connecting');
  useEffect(() => state.subscribe(event => {
    if (event.type === 'connection') setStatus(String(event.status));
  }), []);
  const connected = status === 'connected';
  return (
    <div role="status" aria-live="polite"
      className={`flex shrink-0 items-center gap-2 border-b px-6 py-1.5 text-xs ${status === 'disconnected' ? 'border-warning/30 bg-warning-light text-foreground' : 'border-border bg-sidebar text-muted-foreground'}`}>
      {connected ? <CircleCheck className="h-3.5 w-3.5 text-success" />
        : status === 'connecting' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          : <Unplug className="h-3.5 w-3.5" />}
      {connected ? 'Control plane connected' : status === 'connecting' ? 'Connecting to the control plane…'
        : 'Connection lost. Reconnecting — displayed activity may be out of date.'}
    </div>
  );
}
