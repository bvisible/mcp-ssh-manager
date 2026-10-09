/**
 * The open sessions, as a strip of tabs above the pane.
 *
 * The rail already lists them, and that is not the same thing. The rail is a
 * place you go — it holds the fixed screens too, it collapses to 48px, and a
 * session there is one item in a vertical list of everything. Tabs are what you
 * *work in*: they sit on top of the thing they switch, they show the whole set
 * at a glance while you are looking at one of them, and they are where a hand
 * already reaching for a terminal expects to find them.
 *
 * So: both, deliberately, and driven by the same store — clicking either moves
 * the other.
 */
import { X, Plus, TerminalSquare, FolderOpen, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace, type WorkspaceTab } from '@/stores/workspace';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const ICONS = {
  'dual-browser': FolderOpen,
  'ssh-terminal': TerminalSquare,
  'local-terminal': Monitor,
} as const;

export function SessionTabs() {
  const { tabs, activeTabId, activateTab, removeTab, setView } = useWorkspace();
  if (tabs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch border-b border-border bg-sidebar">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none">
        {tabs.map(tab => (
          <SessionTab
            key={tab.id}
            tab={tab}
            active={activeTabId === tab.id}
            onActivate={() => activateTab(tab.id)}
            onClose={() => removeTab(tab.id)}
          />
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Open another session"
            onClick={() => setView('terminal')}
            className="flex w-9 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open another session</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SessionTab({ tab, active, onActivate, onClose }: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const Icon = ICONS[tab.type];
  return (
    <div
      className={cn(
        'group relative flex min-w-0 max-w-52 shrink-0 items-center gap-2 border-r border-border pl-3 pr-1.5 text-xs transition-colors',
        active
          ? 'bg-background text-foreground'
          : 'text-muted-foreground hover:bg-accent/20 hover:text-foreground'
      )}
    >
      {/* On top rather than underneath: an underline on a tab strip that sits
          above its content reads as belonging to the content, not the tab. */}
      {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
      <button onClick={onActivate} className="flex min-w-0 items-center gap-2 py-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{tab.title}</span>
      </button>
      <button
        aria-label={`Close ${tab.title}`}
        onClick={onClose}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-accent/40 group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
