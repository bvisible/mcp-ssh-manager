/**
 * The commands you keep, next to the terminal where you use them.
 *
 * Carried over from TransHub, which puts it in the terminal's own toolbar
 * rather than on a settings screen — a shortcut you have to navigate to is a
 * shortcut you retype instead.
 *
 * What it does *not* do is run the command itself. It types it into the shell
 * and leaves the Enter to you. That is deliberate: the terminal is the one
 * place in this application where the operator is holding the keyboard, and a
 * menu item that silently executes on production is a menu item somebody
 * brushes past. A command marked `confirmBeforeRun` asks first as well.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, Plus, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { commands as api, type SavedCommand } from '@/lib/api';
import { cn } from '@/lib/utils';

export function CommandsDropdown({
  server,
  onPick,
  onManage,
}: {
  server: string;
  /** Called with the command line to put in front of the operator. */
  onPick: (command: SavedCommand) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedCommand[] | null>(null);
  const [suggestions, setSuggestions] = useState<Omit<SavedCommand, 'id'>[]>([]);
  const [adding, setAdding] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api
      .list(server)
      .then(result => { setItems(result.commands); setSuggestions(result.suggestions); })
      .catch(() => setItems([]));
  }, [open, server]);

  // Clicking away closes it, and so does Escape — a menu that traps you is
  // worse than no menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (command: SavedCommand) => {
    if (command.confirmBeforeRun && !window.confirm(
      `${command.name}\n\n${command.command}\n\nPut this in the terminal on ${server}?`
    )) return;
    onPick(command);
    setOpen(false);
  };

  return (
    <div ref={container} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(current => !current)}>
        <Terminal className="h-3.5 w-3.5" />
        Commands
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </Button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 overflow-hidden rounded-lg border border-border bg-popover shadow-card">
          {items === null ? (
            <div className="flex items-center justify-center p-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="max-h-80 overflow-y-auto">
                {items.map(command => (
                  <button
                    key={command.id}
                    onClick={() => pick(command)}
                    className="group flex w-full items-start gap-2 border-b border-border-subtle px-3 py-2 text-left last:border-b-0 hover:bg-card-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">{command.name}</span>
                        {command.confirmBeforeRun && (
                          <span className="rounded bg-destructive/10 px-1 text-[9px] text-destructive">
                            asks first
                          </span>
                        )}
                        {command.serverNames.length > 0 && (
                          <span className="text-[9px] text-muted-foreground">
                            {command.serverNames.length} server{command.serverNames.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <code className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {command.command}
                      </code>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Delete ${command.name}`}
                      onClick={async event => {
                        event.stopPropagation();
                        await api.remove(command.id);
                        setItems(current => current?.filter(c => c.id !== command.id) ?? null);
                      }}
                      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.click(); }}
                      className="mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent/30"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </button>
                ))}

                {items.length === 0 && suggestions.length > 0 && (
                  <div className="p-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      Nothing saved yet. These are the ones people usually keep — pick any to add it.
                    </p>
                    <div className="grid gap-1">
                      {suggestions.map(suggestion => (
                        <button
                          key={suggestion.name}
                          disabled={adding}
                          onClick={async () => {
                            setAdding(true);
                            try {
                              const saved = await api.save(suggestion);
                              setItems(current => [...(current ?? []), saved]);
                            } finally {
                              setAdding(false);
                            }
                          }}
                          className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-card-hover"
                        >
                          <Plus className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="text-xs">{suggestion.name}</span>
                          <code className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                            {suggestion.command}
                          </code>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => { setOpen(false); onManage(); }}
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Save a new command
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
