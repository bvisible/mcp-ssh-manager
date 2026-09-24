import { useEffect, useState } from 'react';
import { ArchiveRestore, Download, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { vault, state, type RestorePreview, type VaultStatus } from '@/lib/api';

/** Recovery travels as a passphrase-encrypted file. No plaintext credentials enter the UI. */
export function VaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [backupPhrase, setBackupPhrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restorePhrase, setRestorePhrase] = useState('');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const refresh = () => vault.status().then(setStatus);
  useEffect(() => {
    let cancelled = false;
    const reload = () => { void vault.status().then(value => { if (!cancelled) setStatus(value); }).catch(cause => { if (!cancelled) setError(cause.message); }); };
    reload();
    const unsubscribe = state.subscribe(event => { if (event.type === 'servers' || (event.type === 'connection' && event.status === 'connected')) reload(); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage('');
    try { await operation(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const clearRestore = () => { setPreview(null); setContent(''); setRestorePhrase(''); setFileKey(key => key + 1); };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <h2 className="text-sm font-medium">A recovery copy you can take with you</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Your vault is encrypted with a key on this machine. Keep a recovery backup somewhere safe before moving to another computer or reinstalling. You will need its passphrase to restore it.</p>
          {status && <p className="mt-2 text-xs text-muted-foreground">{status.readable
            ? `${status.servers} saved server${status.servers === 1 ? '' : 's'} · ${status.secrets} encrypted secret${status.secrets === 1 ? '' : 's'}`
            : 'The vault cannot be unlocked. Restore a recovery backup to recover access.'}</p>}
          <p className="mt-1 text-xs text-muted-foreground">Backups include saved servers and their credentials. Groups, preferences, host keys and original .env / TOML files need a separate backup.</p>
        </div>
      </div>
      <form className="grid gap-3 rounded-lg border border-border bg-card p-4" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const backup = await vault.backup(backupPhrase);
          const objectUrl = URL.createObjectURL(new Blob([backup.content], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = objectUrl; link.download = backup.filename;
          document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
          setBackupPhrase(''); setConfirmation(''); setMessage('Recovery backup downloaded. Keep the file and its passphrase safe.');
        });
      }}>
        <h3 className="flex items-center gap-2 text-sm font-medium"><LockKeyhole aria-hidden="true" className="h-4 w-4" /> Create a recovery backup</h3>
        <label htmlFor="backup-passphrase" className="text-xs font-medium">Backup passphrase</label>
        <Input id="backup-passphrase" type="password" minLength={8} autoComplete="new-password" required value={backupPhrase} onChange={e => setBackupPhrase(e.target.value)} placeholder="At least 8 characters; a longer phrase is better" />
        <label htmlFor="backup-confirmation" className="text-xs font-medium">Confirm backup passphrase</label>
        <Input id="backup-confirmation" type="password" minLength={8} autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} />
        {confirmation && confirmation !== backupPhrase && <p className="text-xs text-destructive">The passphrases do not match.</p>}
        <Button type="submit" className="w-fit" disabled={busy || !status?.readable || status.servers === 0 || backupPhrase.length < 8 || confirmation !== backupPhrase}><Download className="h-4 w-4" /> Download recovery backup</Button>
      </form>
      <form className="grid gap-3 rounded-lg border border-border bg-card p-4" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          if (!preview) { setPreview(await vault.preview(content, restorePhrase)); return; }
          // A changed vault invalidates the preview; require a fresh review after any failure.
          const reviewed = preview; setPreview(null);
          await vault.restore(content, restorePhrase, reviewed.revision);
          clearRestore(); await refresh(); setMessage('Recovery complete. Your restored servers are available in Servers.');
        });
      }}>
        <h3 className="flex items-center gap-2 text-sm font-medium"><ArchiveRestore aria-hidden="true" className="h-4 w-4" /> Restore a recovery backup</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">Choose an encrypted SSH Manager recovery file. Review the server names before confirming any changes.</p>
        <label htmlFor="recovery-file" className="text-xs font-medium">Recovery file</label>
        <Input key={fileKey} id="recovery-file" type="file" accept=".json,application/json" disabled={busy || Boolean(preview)} onChange={event => {
          const file = event.target.files?.[0]; setPreview(null); setContent('');
          if (file) void run(async () => {
            if (file.size > 16 * 1024 * 1024) throw new Error('Recovery files must be at most 16 MB. Use ssh-manager vault restore for larger files.');
            setContent(await file.text());
          });
        }} />
        <label htmlFor="restore-passphrase" className="text-xs font-medium">Recovery passphrase</label>
        <Input id="restore-passphrase" type="password" autoComplete="off" disabled={busy || Boolean(preview)} required value={restorePhrase} onChange={event => { setRestorePhrase(event.target.value); setPreview(null); }} />
        {preview && <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3" aria-label="Recovery preview">
          <h4 className="text-sm font-medium">Ready to restore {preview.servers.length} server{preview.servers.length === 1 ? '' : 's'}</h4>
          <ul className="max-h-40 overflow-y-auto text-sm">{preview.servers.map(name => <li key={name}>{name}{preview.conflicts.includes(name) ? ' — replaces saved server' : ' — adds server'}</li>)}</ul>
          {preview.replacesUnreadable && <p className="text-sm text-destructive">The unreadable vault will be replaced by this backup.</p>}
          {preview.removed.length > 0 && <p className="text-sm text-destructive">Servers missing from the backup will be removed: {preview.removed.join(', ')}.</p>}
          <p className="text-xs text-muted-foreground">{preview.replacesUnreadable ? 'Other settings and original configuration files stay unchanged.' : 'Other saved servers, settings and original configuration files stay unchanged.'}</p>
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !content || !restorePhrase}>{busy ? 'Working…' : preview ? 'Confirm restore' : 'Preview recovery'}</Button>
          {(content || restorePhrase || preview) && <Button type="button" variant="ghost" disabled={busy} onClick={() => { clearRestore(); setError(null); }}>Cancel recovery</Button>}
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm text-primary">{message}</p>}
    </div>
  );
}
