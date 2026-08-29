/**
 * The rail. Carried over from TransHub, cut down to what a control plane needs.
 *
 * What is kept is the part that took the work: a fixed nav on top for the
 * places you always come back to, dynamic session tabs below for the servers
 * you have open, and the collapse that leaves a 48-pixel strip of icons.
 *
 * What is dropped is everything that served the AI chat — streaming indicators,
 * profile switching, plugin slots.
 */
import { Activity, Clock, HeartPulse, Radio, Server, Settings, Menu, X, TerminalSquare, FolderTree } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspace, type SessionTab } from '@/stores/workspace';

/** The screens that always exist, in the order they earn attention. */
const FIXED_VIEWS = [
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'waiting', label: 'Waiting', icon: Clock },
  { id: 'health', label: 'Health', icon: HeartPulse },
  { id: 'live', label: 'Live', icon: Radio },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'options', label: 'Options', icon: Settings },
] as const;

export function Sidebar() {
  const { view, sessions, activeId, expanded, setView, activate, close, toggleExpanded, pendingCount } =
    useWorkspace();

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r border-border bg-sidebar transition-[width] duration-200',
        expanded ? 'w-52' : 'w-12'
      )}
    >
      <button
        onClick={toggleExpanded}
        aria-label={expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
        className="mt-2 mb-3 ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
      >
        <Menu className="h-4 w-4 text-muted-foreground" />
      </button>

      <nav className="flex flex-col gap-0.5 px-2">
        {FIXED_VIEWS.map(item => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={activeId === null && view === item.id}
            badge={item.id === 'waiting' && pendingCount > 0 ? pendingCount : undefined}
            onClick={() => setView(item.id)}
          />
        ))}
      </nav>

      {sessions.length > 0 && (
        <>
          <div className="mx-2 my-3 border-t border-border-subtle" />
          {expanded && (
            <p className="px-4 pb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              Open servers
            </p>
          )}
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
            {sessions.map(session => (
              <SessionItem
                key={session.id}
                session={session}
                expanded={expanded}
                active={activeId === session.id}
                onActivate={() => activate(session.id)}
                onClose={() => close(session.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  expanded,
  active,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  expanded: boolean;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const button = (
    <button
      onClick={onClick}
      className={cn(
        'relative flex h-9 items-center gap-3 rounded-md px-2 text-sm transition-colors',
        expanded ? 'justify-start' : 'w-8 justify-center',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {expanded && <span className="truncate">{label}</span>}
      {badge !== undefined && (
        <span
          className={cn(
            'flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground',
            expanded ? 'ml-auto' : 'absolute -top-0.5 -right-0.5'
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );

  // A collapsed rail is icons only, so the label has to live somewhere.
  return expanded ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function SessionItem({
  session,
  expanded,
  active,
  onActivate,
  onClose,
}: {
  session: SessionTab;
  expanded: boolean;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const Icon = session.kind === 'files' ? FolderTree : TerminalSquare;
  const row = (
    <div
      className={cn(
        'group flex h-9 items-center gap-2 rounded-md px-2 text-sm transition-colors',
        expanded ? '' : 'w-8 justify-center',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <button onClick={onActivate} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon className="h-4 w-4 shrink-0" />
        {expanded && (
          <span className="min-w-0 flex-1 truncate">
            {session.server}
            {/* Two sessions on the same machine are common — a shell and its
                files — and an icon alone is not enough to tell them apart. */}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {session.kind === 'files' ? 'files' : 'shell'}
            </span>
          </span>
        )}
      </button>
      {expanded && (
        <button
          onClick={onClose}
          aria-label={`Close ${session.server}`}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-background"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  return expanded ? (
    row
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">{session.server}</TooltipContent>
    </Tooltip>
  );
}
