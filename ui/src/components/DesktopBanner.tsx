/**
 * "SSH Manager is also a desktop app", in a browser tab, once.
 *
 * Somebody who installed from npm has the engine, the CLI and this page, and
 * nothing here said the application existed: it was a GitHub page to find, a
 * file to pick for the right architecture, an installer to run by hand. This
 * is the one click instead. The control plane downloads the application of its
 * own version from the release, checks its size and SHA-256 against the
 * release manifest (and, on macOS, its Apple signature), installs it, opens it
 * and hands the approval socket over, then stops. Progress arrives on the
 * event stream, ending with `handover`.
 *
 * Never inside the application, never when the control plane does not offer
 * it (`/api/desktop` is then a 404), and "Not now" is remembered — through the
 * preferences the control plane keeps, because this page's origin changes
 * with every launch and `localStorage` alone would forget by tomorrow.
 *
 * On Linux with the .deb, installing needs `sudo` and a password typed in a
 * terminal, which a click cannot do: the banner shows the command to run.
 */
import { useEffect, useState } from 'react';
import { AppWindow, Check, Copy, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { desktop, state, type DesktopStatus } from '@/lib/api';
import { inDesktopApp } from '@/lib/desktop';
import { readPreference, writePreference } from '@/lib/preferences';
import { useWorkspace } from '@/stores/workspace';

const DISMISSED = 'ssh-manager.desktop-offer-dismissed';

const PHASE_LABEL: Record<string, string> = {
  manifest: 'Finding the release…',
  download: 'Downloading…',
  verify: 'Checking the checksum and the signature…',
  install: 'Installing…',
  open: 'Opening the app…',
};

export function DesktopBanner() {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => readPreference(DISMISSED) === 'true');
  const [phase, setPhase] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const handedOver = useWorkspace(s => s.handedOver);
  const setHandedOver = useWorkspace(s => s.setHandedOver);

  useEffect(() => {
    if (inDesktopApp || dismissed) return;
    let cancelled = false;
    void desktop.status()
      .then(result => {
        if (cancelled || !result) return;
        setStatus(result);
        // A page reloaded mid-install picks the bar up where it is.
        if (result.handingOver) setHandedOver(true);
        else if (result.installing) setPhase(result.phase ?? 'manifest');
      })
      .catch(() => { /* an offer is not worth an error banner */ });
    return () => { cancelled = true; };
  }, [dismissed, setHandedOver]);

  useEffect(() => state.subscribe(event => {
    if (event.type !== 'desktop') return;
    if (event.phase === 'handover') { setHandedOver(true); return; }
    if (event.phase === 'error') {
      setError(typeof event.error === 'string' ? event.error : 'The desktop app was not installed.');
      setPhase(null);
      return;
    }
    if (typeof event.phase === 'string') setPhase(event.phase);
    const received = Number(event.received);
    const total = Number(event.total);
    setProgress(total > 0 && Number.isFinite(received) ? Math.min(1, received / total) : null);
  }), [setHandedOver]);

  if (handedOver) {
    return (
      <div role="status" className="flex shrink-0 items-center gap-3 border-b border-border bg-success-light px-8 py-3 text-sm text-success">
        <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span><b>Continued in the desktop app.</b> You can close this tab.</span>
      </div>
    );
  }

  if (inDesktopApp || dismissed || !status || (!status.supported && !status.installed)) return null;

  const busy = phase !== null;

  const notNow = () => {
    writePreference(DISMISSED, 'true');
    setDismissed(true);
  };

  // One request; the rest — install, open, hand-over — happens on the control
  // plane and is reported on the event stream.
  const run = async () => {
    setError(null);
    setPhase(status.installed ? 'open' : 'manifest');
    try {
      if (status.installed) await desktop.open();
      else await desktop.install();
    } catch (failure) {
      setError((failure as Error).message);
      setPhase(null);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText('ssh-manager app');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the command is on screen */ }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-8 py-3 text-sm">
      <AppWindow className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-[1_1_320px]">
        <b>SSH Manager is also a desktop app:</b> menu bar, native notifications, updates itself.
        {status.installed && status.version && <span className="text-muted-foreground"> Version {status.version} is installed.</span>}
      </p>

      {busy && (
        <div className="ml-auto flex min-w-[220px] items-center gap-3" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
          <span className="text-muted-foreground">{PHASE_LABEL[phase ?? ''] ?? 'Working…'}</span>
          {phase === 'download' && progress !== null && (
            <div
              className="h-1.5 w-28 overflow-hidden rounded-full bg-sunk"
              role="progressbar"
              aria-label="Download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {!busy && (
        <div className="ml-auto flex items-center gap-2">
          {status.method === 'terminal' && !status.installed ? (
            <>
              <code className="rounded-md border border-border bg-secondary px-2.5 py-1.5 font-mono text-[13px]">ssh-manager app</code>
              <Button variant="outline" size="sm" onClick={() => void copyCommand()}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </>
          ) : (
            <Button size="sm" className="font-bold" onClick={() => void run()}>
              {status.installed ? 'Open the app' : 'Install the app'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={notNow}>
            <X className="h-3.5 w-3.5" />
            Not now
          </Button>
        </div>
      )}

      {error && <p className="w-full text-destructive" role="alert">{error} Nothing was installed.</p>}
    </div>
  );
}
