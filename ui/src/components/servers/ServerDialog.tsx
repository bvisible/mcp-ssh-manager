import { cloneElement, useId, useState, type ReactElement } from 'react';
import { ChevronDown, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { servers as api, type ServerConfig } from '@/lib/api';

const BLANK: ServerConfig = { id: '', name: '', host: '', port: 22, username: '', mode: 'unrestricted', approval: 'never' };
const inputClass = 'w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-ring';

export function ServerDialog({ server, prefill, onClose, onSaved }: {
  server: ServerConfig | null;
  prefill?: Partial<ServerConfig>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ServerConfig>(server ?? { ...BLANK, ...prefill });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => setDraft(current => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true); setError(null);
    try { await api.save(draft); onSaved(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-primary" />{server ? `Edit ${server.name}` : 'Add a server'}</DialogTitle>
          <DialogDescription>Credentials stay encrypted on this machine. Leave a password or passphrase blank to keep its saved value.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><Input required value={draft.name} disabled={Boolean(server)} placeholder="production"
              onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} /></Field>
            <Field label="Group"><Input value={draft.category ?? ''} placeholder="optional" onChange={e => set('category', e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="Host"><Input required value={draft.host} placeholder="example.com" onChange={e => set('host', e.target.value)} /></Field>
            <Field label="Port"><Input required type="number" min={1} max={65535} value={draft.port || ''} onChange={e => set('port', Number(e.target.value))} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="User"><Input required value={draft.username} autoComplete="off" onChange={e => set('username', e.target.value)} /></Field>
            <Field label="Password"><Input type="password" autoComplete="new-password" placeholder={server ? 'unchanged' : 'optional'} onChange={e => set('password', e.target.value)} /></Field>
          </div>
          <Field label="Private key"><Input value={draft.privateKey ?? ''} placeholder="~/.ssh/id_ed25519" onChange={e => set('privateKey', e.target.value)} /></Field>
          <Field label="Key passphrase"><Input type="password" autoComplete="new-password" placeholder={server ? 'unchanged' : 'if your key is encrypted'} onChange={e => set('passphrase', e.target.value)} /></Field>
          <Field label="Default directory"><Input value={draft.defaultDirectory ?? ''} placeholder="/var/www" onChange={e => set('defaultDirectory', e.target.value)} /></Field>

          <fieldset className="grid gap-3 rounded-lg border border-border bg-sidebar p-3">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-medium"><ShieldCheck className="h-4 w-4" /> Agent permissions</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode"><select className={inputClass} value={draft.mode ?? 'unrestricted'} onChange={e => set('mode', e.target.value as ServerConfig['mode'])}>
                <option value="unrestricted">Unrestricted</option><option value="readonly">Read only</option><option value="restricted">Restricted</option>
              </select></Field>
              <Field label="Approval"><select className={inputClass} value={draft.approval ?? 'never'} onChange={e => set('approval', e.target.value as ServerConfig['approval'])}>
                <option value="never">Off</option><option value="destructive">Destructive requests</option><option value="always">Every request</option>
              </select></Field>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{draft.approval && draft.approval !== 'never'
              ? 'Requests needing approval wait for you. If the control plane is unavailable, they are refused.'
              : 'Agents can work without this interface. Turn on approval when you want to review their requests.'}</p>
            {draft.mode === 'restricted' && <>
              <Patterns label="Allowed command patterns" value={draft.allowPatterns} onChange={value => set('allowPatterns', value)} />
              <p className="text-xs text-muted-foreground">One regular expression per line. With no allowed patterns, all commands are refused.</p>
            </>}
            {(draft.mode !== 'unrestricted' || (draft.denyPatterns?.length ?? 0) > 0) &&
              <Patterns label="Denied command patterns" value={draft.denyPatterns} onChange={value => set('denyPatterns', value)} />}
          </fieldset>

          <details className="rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center justify-between p-3 text-sm font-medium">Advanced connection settings <ChevronDown className="h-4 w-4" /></summary>
            <div className="grid gap-3 border-t border-border p-3">
              <Field label="Description"><Input value={draft.description ?? ''} onChange={e => set('description', e.target.value)} /></Field>
              <Field label="Jump server" hint="Name of another configured server to connect through."><Input value={draft.proxyJump ?? ''} placeholder="bastion" onChange={e => set('proxyJump', e.target.value)} /></Field>
              <Field label="Proxy command"><Input value={draft.proxyCommand ?? ''} placeholder="ssh -W %h:%p bastion" onChange={e => set('proxyCommand', e.target.value)} /></Field>
              <Field label="Remote platform"><select className={inputClass} value={draft.platform ?? 'linux'} onChange={e => set('platform', e.target.value)}>
                <option value="linux">Linux / Unix</option><option value="windows">Windows</option><option value="darwin">macOS</option>
              </select></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.forwardAgent ?? false} onChange={e => set('forwardAgent', e.target.checked)} /> Forward the SSH agent</label>
              <Field label="Audit log path"><Input value={draft.auditLog ?? ''} placeholder="/path/to/audit.jsonl" onChange={e => set('auditLog', e.target.value)} /></Field>
            </div>
          </details>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !draft.name || !draft.host || !draft.username}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="grid gap-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{cloneElement(children, { id })}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
}
function Patterns({ label, value, onChange }: { label: string; value?: string[]; onChange: (value: string[]) => void }) {
  // Keep the editable text until blur: splitting on each keystroke eats the newline.
  const [text, setText] = useState((value ?? []).join('\n'));
  return <Field label={label}><textarea className={`${inputClass} min-h-20 font-mono text-xs`} value={text}
    onChange={e => setText(e.target.value)} onBlur={() => onChange(text.split('\n').map(line => line.trim()).filter(Boolean))} /></Field>;
}
