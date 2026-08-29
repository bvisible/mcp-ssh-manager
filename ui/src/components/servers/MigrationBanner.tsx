/**
 * Offers to bring servers from a .env into the vault.
 *
 * The one thing missing from the migration story: nobody reads a changelog, so
 * an operator upgrading from 3.8 would use v4 for months without learning the
 * vault exists. This says so, once, where they are already looking.
 *
 * It offers and never acts on its own. Their setup works; the vault has to earn
 * the move by being better, not by happening while they are not looking. The
 * .env is never touched either way — it remains the fallback, and deleting it
 * is a separate, deliberate decision made later.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, FileKey, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { migration, type PendingServer } from '@/lib/api';

const DISMISSED_KEY = 'ssh-manager.migration-dismissed';

export function MigrationBanner({ onImported }: { onImported: () => void }) {
  const [pending, setPending] = useState<PendingServer[] | null>(null);
  const [envPath, setEnvPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    migration
      .state()
      .then(state => {
        setPending(state.pending);
        setEnvPath(state.envPath);
      })
      .catch(() => { /* an offer that cannot be made is not an error */ });
  }, []);

  if (dismissed || !pending || pending.length === 0) return null;

  const withSecrets = pending.filter(server => server.secrets > 0).length;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      /* dismissing for this session is better than not being able to dismiss */
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-start gap-3">
        <FileKey className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {pending.length} server{pending.length > 1 ? 's are' : ' is'} configured in a file, not in the vault
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {envPath && <><code className="font-mono">{envPath}</code> — </>}
            {withSecrets > 0
              ? `${withSecrets} of them keep${withSecrets > 1 ? '' : 's'} credentials in clear text. `
              : ''}
            Importing encrypts the secrets and lets you edit these servers here. The file is left
            exactly as it is, and keeps working.
          </p>

          <ul className="mt-2 flex flex-wrap gap-1.5">
            {pending.map(server => (
              <li key={server.name}
                className="rounded-md border border-border bg-card px-2 py-0.5 text-xs">
                {server.name}
                <span className="ml-1.5 text-muted-foreground">
                  {server.user ? `${server.user}@` : ''}{server.host}
                </span>
                {server.secrets > 0 && (
                  <span className="ml-1.5 text-accent">
                    {server.secrets} secret{server.secrets > 1 ? 's' : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await migration.run(pending.map(server => server.name));
                  setPending([]);
                  onImported();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Importing…' : `Import ${pending.length > 1 ? 'them' : 'it'}`}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={dismiss}>
              Not now
            </Button>
            <p className="text-[10px] text-muted-foreground">
              {/* Said here rather than after the fact: the vault's key belongs
                  to this machine, and that is the thing to know before it
                  becomes the only copy of anything. */}
              Afterwards, run <code className="font-mono">ssh-manager vault backup</code> — the
              vault key lives in this machine's keychain and does not travel.
            </p>
          </div>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
