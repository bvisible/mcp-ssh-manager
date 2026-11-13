/**
 * Options → Updates: which version this is, whether there is a newer one, and
 * the clicks that act on it. Only drawn inside the desktop application (the
 * control plane answers 404 elsewhere, and the tab is then absent).
 *
 * Updates are offered, never applied: the application holds SSH connections
 * and the approval socket an agent may be blocked on. Downloading is a click,
 * and installing is a second one that restarts the window. The text says so,
 * because "when will this restart?" is the question that makes people leave
 * updates alone.
 */
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAppUpdate } from '@/stores/appUpdate.store';
import { useWorkspace } from '@/stores/workspace';
import { tr, trn, useLocale } from '@/lib/i18n';

const RELEASES = 'https://github.com/bvisible/mcp-ssh-manager/releases';

function when(iso: string | undefined): string {
  if (!iso) return tr("not yet");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? tr("not yet") : date.toLocaleString();
}

export function UpdatesPanel() {
  useLocale();
  const { info, busy, error, check, download, install } = useAppUpdate();
  const pending = useWorkspace(s => s.pendingCount);
  if (!info) return null;

  const preview = info.channel === 'preview';
  const status = info.status;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium">SSH Manager {info.currentVersion}</h2>
          {preview && <Badge variant="secondary">{tr("preview build")}</Badge>}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {preview
            ? tr("You are on a preview. You will be offered newer previews and the stable release when it comes out.")
            : tr("You receive stable releases.")}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4" aria-live="polite">
        {status === 'checking' && (
          <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{tr("Checking for updates…")}</p>
        )}

        {(status === 'idle' || status === 'error') && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {info.error ? tr("Could not check for updates.") : info.checkedAt ? tr("You are up to date.") : tr("Not checked yet.")}
            </p>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
              <RefreshCw className="h-3.5 w-3.5" />{tr("Check now")}</Button>
          </div>
        )}

        {status === 'available' && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{tr('Version {{version}} is available', { version: info.version })}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{tr("Downloading does not change anything you are running; you choose when to restart.")}</p>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void download()}>
              <Download className="h-3.5 w-3.5" />{tr("Download")} {info.version}
            </Button>
          </div>
        )}

        {status === 'downloading' && (
          <div>
            <p className="text-sm font-medium">{tr("Downloading")} {info.version}… {info.percent ?? 0}%</p>
            <div
              role="progressbar"
              aria-label={tr("Download")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={info.percent ?? 0}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-primary transition-[width]" style={{ width: `${info.percent ?? 0}%` }} />
            </div>
          </div>
        )}

        {status === 'ready' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{tr('Version {{version}} is ready to install', { version: info.version })}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{tr("It installs when you restart, or by itself the next time you quit.")}</p>
              </div>
              <Button size="sm" disabled={busy} onClick={() => void install()}>
                <RotateCw className="h-3.5 w-3.5" />{tr("Restart to update")}</Button>
            </div>
            {pending > 0 && (
              <p role="alert" className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
                {trn(pending,
                  '{{n}} command is waiting for your decision. Restarting drops it: the agent will be told no.',
                  '{{n}} commands are waiting for your decision. Restarting drops them: the agents will be told no.')}
              </p>
            )}
          </div>
        )}

        <dl className="mt-3 grid gap-x-6 gap-y-1 border-t border-border-subtle pt-3 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="flex gap-2"><dt>{tr("Last checked")}</dt><dd className="text-foreground">{when(info.checkedAt)}</dd></div>
          <div className="flex gap-2">
            <dt>{tr("Release notes")}</dt>
            <dd>
              <a
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
                href={`${RELEASES}${info.version ? `/tag/v${info.version}` : ''}`}
                target="_blank"
                rel="noreferrer"
              >
                {info.version ? tr("Version {{v0}}", { v0: info.version }) : tr("All releases")}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </dd>
          </div>
        </dl>

        {(error || info.error) && (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error ?? info.error}
          </p>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{tr("The application checks when it starts and every six hours, and tells you here, in the sidebar and once per version in a notification. The npm engine, if you use one, is updated with npm and is not part of this.")}</p>
    </div>
  );
}
