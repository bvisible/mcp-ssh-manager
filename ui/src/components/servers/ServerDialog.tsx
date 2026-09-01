/**
 * Add or edit a server, with the multi-account model carried over from
 * TransHub: one machine, several ways in.
 *
 * The reason that model earns its keep here: on a real box you have a deploy
 * user, a root you use rarely, and sometimes an app user with its own key.
 * Modelling those as three separate "servers" duplicates the host, the port and
 * the jump host, and they drift.
 */
import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { servers as api, type ServerAccount, type ServerConfig } from '@/lib/api';

const BLANK: ServerConfig = {
  id: '', name: '', host: '', port: 22, username: '', mode: 'unrestricted', approval: 'never',
};

export function ServerDialog({
  server,
  prefill,
  onClose,
  onSaved,
}: {
  server: ServerConfig | null;
  /**
   * Fields to start a *new* server with, when it is being created from
   * somewhere that already knows something about it — a known host, today.
   * Distinct from `server`, which means an existing one is being edited.
   */
  prefill?: Partial<ServerConfig>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ServerConfig>(server ?? { ...BLANK, ...prefill });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) =>
    setDraft(current => ({ ...current, [key]: value }));

  const accounts = draft.accounts ?? [];
  const setAccounts = (next: ServerAccount[]) => set('accounts', next);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.save(draft);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${server.name}` : 'Add a server'}</DialogTitle>
          <DialogDescription>
            Stored encrypted. Secrets are written once and never read back into this page — leaving a
            password field blank keeps the one already saved.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={draft.name}
                disabled={Boolean(server)}
                placeholder="production"
                onChange={e => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              />
            </Field>
            <Field label="Group">
              <Input
                value={draft.category ?? ''}
                placeholder="optional"
                onChange={e => set('category', e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <Field label="Host">
              <Input value={draft.host} placeholder="example.com"
                onChange={e => set('host', e.target.value)} />
            </Field>
            <Field label="Port">
              <Input type="number" value={draft.port}
                onChange={e => set('port', Number(e.target.value) || 22)} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="User">
              <Input value={draft.username} onChange={e => set('username', e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" placeholder={server ? 'unchanged' : ''}
                onChange={e => set('password', e.target.value)} />
            </Field>
          </div>

          <Field label="Private key">
            <Input value={draft.privateKey ?? ''} placeholder="~/.ssh/id_ed25519"
              onChange={e => set('privateKey', e.target.value)} />
          </Field>

          <Field label="Default directory">
            <Input value={draft.defaultDirectory ?? ''} placeholder="/var/www"
              onChange={e => set('defaultDirectory', e.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Mode" hint="What an agent may do">
              <Select value={draft.mode ?? 'unrestricted'}
                options={['unrestricted', 'readonly', 'restricted']}
                onChange={value => set('mode', value as ServerConfig['mode'])} />
            </Field>
            <Field label="Approval" hint="When to ask you first">
              <Select value={draft.approval ?? 'never'}
                options={['never', 'destructive', 'always']}
                onChange={value => set('approval', value as ServerConfig['approval'])} />
            </Field>
          </div>

          <section className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Additional accounts</p>
                <p className="text-xs text-muted-foreground">
                  Other ways into the same machine — a deploy user, root, an app user.
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setAccounts([
                    ...accounts,
                    { id: crypto.randomUUID(), label: '', username: '', isDefault: accounts.length === 0 },
                  ])
                }
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>

            {accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None. The user above is used for every connection.
              </p>
            ) : (
              <div className="grid gap-2">
                {accounts.map((account, index) => (
                  <div key={account.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                    <Input
                      value={account.label}
                      placeholder="label (root, deploy…)"
                      onChange={e => {
                        const next = [...accounts];
                        next[index] = { ...account, label: e.target.value };
                        setAccounts(next);
                      }}
                    />
                    <Input
                      value={account.username}
                      placeholder="username"
                      onChange={e => {
                        const next = [...accounts];
                        next[index] = { ...account, username: e.target.value };
                        setAccounts(next);
                      }}
                    />
                    <div className="flex items-center gap-1">
                      {account.metadata?.isRoot && <Badge variant="outline">root</Badge>}
                      {account.privateKey && <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${account.label || 'account'}`}
                        onClick={() => setAccounts(accounts.filter(a => a.id !== account.id))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !draft.name || !draft.host}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>
        {label}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span>}
      </Label>
      {children}
    </div>
  );
}

/** A plain select: three fixed options do not justify a listbox implementation. */
function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {options.map(option => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}
