/**
 * Create or edit a server group.
 *
 * Groups have two origins and they behave differently, which the form has to
 * say rather than let you discover: a group named in `.server-groups.json` is
 * editable here, while one derived from the servers' own `group` field follows
 * that field and cannot be edited without the two drifting apart.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { groups as api, type Group } from '@/lib/api';
import { useServersStore } from '@/stores/servers.store';
import { cn } from '@/lib/utils';

export function GroupDialog({
  group,
  onClose,
  onSaved,
}: {
  group: Group | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const allServers = useServersStore(s => s.servers);
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(group?.servers ?? []));
  const [strategy, setStrategy] = useState<'parallel' | 'sequential'>(group?.strategy ?? 'parallel');
  const [delay, setDelay] = useState(String(group?.delay ?? 0));
  const [stopOnError, setStopOnError] = useState(Boolean(group?.stopOnError));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (server: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(server)) next.delete(server);
      else next.add(server);
      return next;
    });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? `Edit ${group.name}` : 'New group'}</DialogTitle>
          <DialogDescription>
            A group runs one command across several machines. Stored in{' '}
            <code className="font-mono text-xs">.server-groups.json</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              disabled={Boolean(group)}
              placeholder="web-tier"
              onChange={e => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Description <span className="font-normal text-muted-foreground">optional</span></Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label>
              Servers
              <span className="ml-1.5 font-normal text-muted-foreground">
                {selected.size} of {allServers.length}
              </span>
            </Label>
            {allServers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No server in the vault yet — add one first.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
                {allServers.map(server => (
                  <button
                    key={server.name}
                    onClick={() => toggle(server.name)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      selected.has(server.name)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent/30'
                    )}
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Order</Label>
              <select
                value={strategy}
                onChange={e => setStrategy(e.target.value as 'parallel' | 'sequential')}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <option value="parallel">all at once</option>
                <option value="sequential">one after another</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>
                Delay
                <span className="ml-1.5 font-normal text-muted-foreground">ms between servers</span>
              </Label>
              <Input
                type="number"
                value={delay}
                disabled={strategy === 'parallel'}
                onChange={e => setDelay(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={stopOnError}
              onChange={e => setStopOnError(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Stop at the first failure
            <span className="text-xs text-muted-foreground">
              {/* Which one you want depends on the command, and getting it
                  wrong is expensive in opposite directions. */}
              — otherwise every server is attempted
            </span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={saving || !name || selected.size === 0}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await api.save({
                  name,
                  description,
                  servers: [...selected],
                  strategy,
                  delay: Number(delay) || 0,
                  stopOnError,
                });
                onSaved();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
