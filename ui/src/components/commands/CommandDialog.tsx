/**
 * Save a command for later.
 *
 * Opens from the terminal it will be used in, so the server it was written
 * against is pre-selected — most saved commands are written while looking at
 * the output of the thing they wrap.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { commands as api, type SavedCommand } from '@/lib/api';
import { useServersStore } from '@/stores/servers.store';
import { cn } from '@/lib/utils';

export function CommandDialog({
  server,
  existing,
  onClose,
  onSaved,
}: {
  /** The terminal this was opened from, if any. */
  server?: string;
  existing?: SavedCommand;
  onClose: () => void;
  onSaved?: (command: SavedCommand) => void;
}) {
  const allServers = useServersStore(s => s.servers);
  const [name, setName] = useState(existing?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [workingDirectory, setWorkingDirectory] = useState(existing?.workingDirectory ?? '');
  const [confirmBeforeRun, setConfirmBeforeRun] = useState(existing?.confirmBeforeRun ?? false);
  const [scope, setScope] = useState<Set<string>>(new Set(existing?.serverNames ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (target: string) =>
    setScope(current => {
      const next = new Set(current);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit command' : 'Save a command'}</DialogTitle>
          <DialogDescription>
            It appears in the list next to any terminal it applies to.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} placeholder="Reload nginx" onChange={e => setName(e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label>Command</Label>
            <textarea
              value={command}
              onChange={e => setCommand(e.target.value)}
              rows={3}
              placeholder="systemctl reload nginx"
              className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Description <span className="font-normal text-muted-foreground">optional</span></Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Directory <span className="font-normal text-muted-foreground">optional</span></Label>
              <Input
                value={workingDirectory}
                placeholder="/var/www"
                onChange={e => setWorkingDirectory(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>
              Where it is offered
              <span className="ml-1.5 font-normal text-muted-foreground">
                {scope.size === 0 ? 'every server' : `${scope.size} selected`}
              </span>
            </Label>
            {/* Scoping matters: `systemctl reload nginx` offered on a database
                server is a mistake waiting for a tired evening. */}
            <div className="flex flex-wrap gap-1.5 rounded-md border border-border p-2">
              {allServers.map(target => (
                <button
                  key={target.name}
                  onClick={() => toggle(target.name)}
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs transition-colors',
                    scope.has(target.name)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent/30'
                  )}
                >
                  {target.name}
                </button>
              ))}
              {allServers.length === 0 && (
                <span className="text-xs text-muted-foreground">No server in the vault yet.</span>
              )}
            </div>
            {scope.size === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Selecting none offers it everywhere.
                {server && (
                  <button className="ml-1 underline" onClick={() => setScope(new Set([server]))}>
                    Limit to {server}?
                  </button>
                )}
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmBeforeRun}
              onChange={e => setConfirmBeforeRun(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Ask before putting it in the terminal
            <span className="text-xs text-muted-foreground">— for the ones that delete things</span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={saving || !name.trim() || !command.trim()}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                const saved = await api.save({
                  id: existing?.id,
                  name,
                  command,
                  description,
                  workingDirectory,
                  confirmBeforeRun,
                  serverNames: [...scope],
                });
                onSaved?.(saved);
                onClose();
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
