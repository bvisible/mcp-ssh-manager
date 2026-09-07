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
import { readPreference, writePreference } from '@/lib/preferences';

const DISMISSED_KEY = 'ssh-manager.migration-dismissed';

export function MigrationBanner({ onImported }: { onImported: () => void }) {
  const [pending, setPending] = useState<PendingServer[] | null>(null);
  const [envPath, setEnvPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => readPreference(DISMISSED_KEY) === 'true');

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
    writePreference(DISMISSED_KEY, 'true');
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-start gap-3">
        <FileKey className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Your existing setup keeps working
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {envPath && <><code className="font-mono">{envPath}</code> — </>}
            {withSecrets > 0
              ? `${withSecrets} of them keep${withSecrets > 1 ? '' : 's'} credentials in clear text. `
              : ''}
            Bring {pending.length} server{pending.length > 1 ? 's' : ''} into this workspace to edit
            them here. Importing is optional and leaves the original configuration unchanged.
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
                setError(null);
                try {
                  await migration.run(pending.map(server => server.name));
                  setPending([]);
                  onImported();
                } catch (cause) {
                  setError((cause as Error).message);
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
              Afterwards, create a recovery backup in Options → Vault. Your encryption key
              belongs to this machine; the backup lets you restore elsewhere.
            </p>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
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
