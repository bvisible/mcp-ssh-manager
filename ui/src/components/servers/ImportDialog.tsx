/**
 * Bringing servers in, from the interface.
 *
 * All of this existed in the CLI and nowhere else — seven formats, a hundred
 * servers readable out of Transmit on this machine alone — which made it, in
 * practice, a feature nobody would ever find. Somebody looking at an empty
 * server list does not go looking for `ssh-manager import` in a README.
 *
 * Two ways in, in the order people actually have them:
 *
 *   - **what is already on this machine** — probed, counted, one click. The
 *     count is the point: "23 servers" is a reason to press it, "FileZilla" on
 *     its own is a question.
 *   - **a file** — a spreadsheet a colleague sent, an export from a tool that
 *     is not installed here. The format is worked out rather than asked for.
 *
 * Nothing is written before it has been shown. Import is the one operation
 * where a preview is not a nicety: the alternative is finding out afterwards
 * that forty rows arrived under the wrong names.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { imports, type ImportPreview, type ImportSource } from '@/lib/api';

/** Base64 without a data: prefix, which is what the preview route expects. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function ImportDialog({ onClose, onImported }: {
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    imports.sources()
      .then(answer => setSources(answer.sources))
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const look = async (body: Parameters<typeof imports.preview>[0]) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await imports.preview(body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    await look({ filename: file.name, content: await readAsBase64(file) });
  };

  const write = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const list = replace ? [...preview.fresh, ...preview.conflicts] : preview.fresh;
      const { written } = await imports.apply(list);
      onImported(written);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const writing = preview
    ? (replace ? preview.fresh.length + preview.conflicts.length : preview.fresh.length)
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Download className="h-4.5 w-4.5 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Import servers</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {preview
                ? preview.source
                : 'From another tool, or from a file. No password is ever read.'}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {error && (
          <p className="border-b border-destructive/30 bg-destructive-light px-5 py-2 text-xs">{error}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {busy && !preview && (
            <p className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading…
            </p>
          )}

          {!preview && !busy && (
            <div className="space-y-4">
              {sources === null && (
                <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Looking around…
                </p>
              )}

              {sources && sources.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-medium tracking-wider uppercase text-muted-foreground">
                    Already on this machine
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {sources.map(source => (
                      <button
                        key={source.id}
                        onClick={() => void look({ source: source.id })}
                        className="flex w-full items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-card-hover"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{source.label}</span>
                        <Badge variant="secondary" className="shrink-0">
                          {source.count} server{source.count === 1 ? '' : 's'}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-xs font-medium tracking-wider uppercase text-muted-foreground">
                  From a file
                </h3>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept=".xlsx,.csv,.xml,.reg,.json,.mxtsessions,.txt,config"
                  onChange={e => void pickFile(e.target.files?.[0])}
                />
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  Choose a file
                </Button>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  A spreadsheet, a CSV, an OpenSSH config, or an export from FileZilla,
                  PuTTY, Termius or MobaXterm. The format is worked out for you.
                </p>
              </div>
            </div>
          )}

          {preview && (
            <div className="space-y-3">
              {preview.fresh.length === 0 && preview.conflicts.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  Nothing to import from that.
                </p>
              )}

              {[...preview.fresh, ...preview.conflicts].length > 0 && (
                <div className="overflow-hidden rounded-lg border border-border">
                  {preview.fresh.map(server => (
                    <div key={`n-${server.name}`} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0">
                      <span className="w-4 shrink-0 text-center text-xs text-success">+</span>
                      <span className="w-36 shrink-0 truncate text-sm">{server.name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                        {server.user ? `${server.user}@` : ''}{server.host}
                        {server.port ? `:${server.port}` : ''}
                      </span>
                      {server.group && <Badge variant="outline" className="shrink-0">{server.group}</Badge>}
                    </div>
                  ))}
                  {preview.conflicts.map(server => (
                    <div key={`c-${server.name}`} className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 opacity-60 last:border-b-0">
                      <span className="w-4 shrink-0 text-center text-xs">=</span>
                      <span className="w-36 shrink-0 truncate text-sm">{server.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {replace ? 'will be replaced' : 'already configured — left alone'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {preview.conflicts.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
                  Replace the {preview.conflicts.length} that already exist
                </label>
              )}

              {preview.warnings.length > 0 && (
                <div className="rounded-lg border border-border bg-muted p-3">
                  <h3 className="mb-1 text-xs font-medium">Notes</h3>
                  <ul className="space-y-0.5">
                    {preview.warnings.slice(0, 8).map((note, i) => (
                      <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">{note}</li>
                    ))}
                    {preview.warnings.length > 8 && (
                      <li className="text-[11px] text-muted-foreground">
                        …and {preview.warnings.length - 8} more
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {preview && (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => { setPreview(null); setReplace(false); }}>
              Back
            </Button>
            <span className="ml-auto flex items-center gap-2">
              <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />
              <Button size="sm" disabled={busy || writing === 0} onClick={() => void write()}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Import {writing} server{writing === 1 ? '' : 's'}
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
