/**
 * The rail, carried over from TransHub with the AI-chat parts removed.
 *
 * Kept: the collapse toggle and its persisted state, rename-on-double-click,
 * the initials shown when collapsed.
 *
 * Changed for 4.0: the product's mark at the top, and the destinations grouped
 * by what they are about — your machines, what agents are doing, the state of
 * the fleet, what you have open. A flat list of seven grey icons gave "Waiting",
 * the one screen that can block an agent, the same weight as "Activity". The
 * connection status lives at the foot of the rail now instead of in a strip
 * across every page: when it is fine it is a dot, not a row of content.
 *
 * Removed: Home, the local terminal, the AI chat, the web browser, plugins and
 * settings — none of which exist here — along with the streaming ring and the
 * profile dot they carried.
 */
import { useState, useRef, useEffect } from 'react'
import { Server, Clock, HeartPulse, Radio, Activity, Settings, PanelLeftClose, PanelLeftOpen, FolderOpen, X, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspace, type WorkspaceTab, type ViewId } from '@/stores/workspace'
import { useServersStore } from '@/stores/servers.store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { needsTitleBarRoom, hasOverlayControls } from '@/lib/desktop'
import { ConnectionBadge } from '@/components/layout/ConnectionStatus'

type NavItem = { id: ViewId; label: string; icon: React.ComponentType<{ className?: string }> }

/** The screens that always exist, grouped, in the order they earn attention. */
const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { id: 'servers', label: 'Servers', icon: Server },
      { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
    ],
  },
  {
    label: 'Agents',
    items: [
      { id: 'waiting', label: 'Waiting', icon: Clock },
      { id: 'live', label: 'Live', icon: Radio },
      { id: 'activity', label: 'Activity', icon: Activity },
    ],
  },
  {
    label: 'Fleet',
    items: [{ id: 'health', label: 'Health', icon: HeartPulse }],
  },
]

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).charAt(0).toUpperCase() + name.slice(1, 2).toLowerCase()
}

/** The application icon, drawn rather than loaded: it has to be crisp at 24px. */
function BrandMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 28 28" aria-hidden="true" className="shrink-0 text-foreground">
      {/* The ring is the text colour at low opacity: invisible on the light
          rail, and what keeps the black tile from vanishing into the dark one. */}
      <rect x="0.5" y="0.5" width="27" height="27" rx="6.5" fill="#141413" stroke="currentColor" strokeOpacity="0.18" />
      <polyline points="8.5 9 13.5 14 8.5 19" fill="none" stroke="#E0611A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="15.5" y1="19.5" x2="20.5" y2="19.5" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export function Sidebar() {
  const {
    view,
    tabs,
    activeTabId,
    expanded: sidebarExpanded,
    pendingCount,
    setView,
    activateTab,
    removeTab,
    updateTab,
    toggleExpanded
  } = useWorkspace()
  const serverCount = useServersStore(s => s.servers.length)

  // A panel icon, which is what this button does. It used to be a cross, and a
  // cross means close — people read it as "close the application" or "close
  // the panel for good", not "make the rail narrower". The two states are the
  // same glyph mirrored, so the direction it will move in is visible before you
  // press it.
  const toggle = (
    <button
      onClick={toggleExpanded}
      aria-label={sidebarExpanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
      title={sidebarExpanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
      className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {sidebarExpanded
        ? <PanelLeftClose className="h-4 w-4" />
        : <PanelLeftOpen className="h-4 w-4" />}
    </button>
  )

  return (
    <div
      className={cn(
        'sidebar-nav flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
        // macOS draws its three window buttons over the top-left corner, about
        // 70px of it. Collapsed to 56px the rail would put them on the page
        // title, so in the app it stays wide enough to hold them.
        sidebarExpanded ? 'w-56' : needsTitleBarRoom ? 'w-[76px]' : 'w-14'
      )}
    >
      {/* The row the macOS window buttons sit in, level with the page header
          beside it. Draggable, like the title bar it replaces. */}
      {needsTitleBarRoom && (
        <div className="drag-region flex h-12 shrink-0 items-center justify-end px-3">
          {sidebarExpanded && toggle}
        </div>
      )}

      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-2.5',
          sidebarExpanded ? 'px-4' : 'justify-center',
          // Windows and Linux draw their buttons on the right, over the page
          // header; the rail's top row is still part of the bar you drag.
          hasOverlayControls && 'drag-region'
        )}
      >
        {sidebarExpanded ? (
          <>
            <BrandMark />
            {/* One line, always: the name wrapping onto two lines read as two
                words that happen to be near each other. */}
            <span className="whitespace-nowrap text-[17px] tracking-[-0.01em]">
              <b className="font-bold">ssh</b> manager
            </span>
            {!needsTitleBarRoom && <span className="ml-auto">{toggle}</span>}
          </>
        ) : (
          toggle
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-2 scrollbar-none" aria-label="Main">
        {NAV_GROUPS.map((group, index) => (
          <div key={group.label ?? index} className="flex flex-col gap-0.5">
            {group.label && (sidebarExpanded
              ? <div className="px-2.5 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{group.label}</div>
              : <div className="mx-2 mb-1 border-t border-sidebar-border" />)}
            {group.items.map(item => (
              <SidebarItem
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={activeTabId === null && view === item.id}
                expanded={sidebarExpanded}
                badge={item.id === 'waiting' && pendingCount > 0 ? pendingCount : undefined}
                meta={item.id === 'servers' && serverCount > 0 ? String(serverCount) : undefined}
                onClick={() => setView(item.id)}
              />
            ))}
          </div>
        ))}

        {/* Dynamic sessions */}
        {tabs.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {sidebarExpanded
              ? <div className="px-2.5 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Open</div>
              : <div className="mx-2 mb-1 border-t border-sidebar-border" />}
            {tabs.map((tab) => (
              <SessionItem
                key={tab.id}
                session={tab}
                active={activeTabId === tab.id}
                expanded={sidebarExpanded}
                onActivate={() => activateTab(tab.id)}
                onClose={() => removeTab(tab.id)}
                onRename={(newTitle) => updateTab(tab.id, { title: newTitle })}
              />
            ))}
          </div>
        )}
      </nav>

      {/* Pinned to the bottom, where settings belong — the places you configure
          once are not the places you work. The connection sits with them: it
          only needs a look when it is not fine, and then it says so loudly at
          the top of the page as well. */}
      <div className="flex flex-col gap-1.5 px-2 pb-3 pt-2">
        <SidebarItem
          icon={Settings}
          label="Options"
          active={activeTabId === null && view === 'options'}
          expanded={sidebarExpanded}
          onClick={() => setView('options')}
        />
        <ConnectionBadge expanded={sidebarExpanded} />
      </div>
    </div>
  )
}

function SidebarItem({
  icon: Icon,
  label,
  active,
  expanded,
  onClick,
  badge,
  meta
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  expanded: boolean
  onClick: () => void
  /** Something waiting on you: drawn solid, in the accent. */
  badge?: number
  /** A quiet count, for orientation only. */
  meta?: string
}) {
  const button = (
    <button
      // Collapsed, these are icon-only buttons. Without a name they are
      // invisible to a screen reader and unreachable by anything that looks
      // elements up by their label.
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={onClick}
      className={cn(
        'no-drag relative flex h-10 w-full items-center gap-2.5 rounded-lg transition-colors',
        expanded ? 'px-2.5' : 'justify-center',
        active
          ? 'bg-sidebar-accent font-bold text-sidebar-accent-foreground'
          : 'font-medium text-sidebar-foreground hover:bg-accent/50'
      )}
    >
      <span className="relative shrink-0">
        <Icon className="h-[18px] w-[18px]" />
        {!expanded && badge !== undefined && (
          <span className="absolute -right-1.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
            {badge}
          </span>
        )}
      </span>
      {expanded && <span className="flex-1 truncate text-left text-sm">{label}</span>}
      {expanded && badge !== undefined && (
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground tabular-nums">
          {badge}
        </span>
      )}
      {expanded && badge === undefined && meta !== undefined && (
        <span className="shrink-0 text-xs font-medium text-muted-foreground tabular-nums">{meta}</span>
      )}
    </button>
  )

  if (expanded) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function SessionItem({
  session,
  active,
  expanded,
  onActivate,
  onClose,
  onRename
}: {
  session: WorkspaceTab
  active: boolean
  expanded: boolean
  onActivate: () => void
  onClose: () => void
  onRename: (newTitle: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(session.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  const cancelRename = () => {
    setEditValue(session.title)
    setEditing(false)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(session.title)
    setEditing(true)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitRename()
    } else if (e.key === 'Escape') {
      cancelRename()
    }
  }

  const Icon = session.type === 'dual-browser' ? FolderOpen : TerminalSquare
  const kind = session.type === 'dual-browser' ? 'files' : 'shell'
  const initials = getInitials(session.title)

  const button = (
    <button
      // Same reason as the fixed rail items: collapsed, this is an icon and a
      // pair of initials, with no name unless one is given.
      aria-label={session.title}
      aria-current={active ? 'page' : undefined}
      title={session.title}
      onClick={onActivate}
      className={cn(
        'no-drag group relative flex h-10 w-full items-center gap-2.5 rounded-lg transition-colors',
        expanded ? 'pl-2.5 pr-1' : 'justify-center',
        active
          ? 'bg-sidebar-accent font-bold text-sidebar-accent-foreground'
          : 'font-medium text-sidebar-foreground hover:bg-accent/50'
      )}
    >
      <span className="relative shrink-0">
        <Icon className="h-[18px] w-[18px]" />
        {!expanded && session.badge && session.badge > 1 && (
          <span className="absolute -right-1.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
            {session.badge}
          </span>
        )}
      </span>

      {expanded ? (
        <>
          {editing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 bg-transparent text-sm font-medium outline-none border-b border-primary"
            />
          ) : (
            <span
              className="flex-1 truncate text-left text-sm"
              onDoubleClick={handleDoubleClick}
            >
              {session.title}
            </span>
          )}
          {session.badge && session.badge > 1 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-xs font-medium text-primary">
              {session.badge}
            </span>
          )}
          <span className="text-xs font-medium text-muted-foreground group-hover:hidden">{kind}</span>
          <span
            role="button"
            tabIndex={0}
            aria-label={`Close ${session.title}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              }
            }}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-accent group-hover:flex focus-visible:flex cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        </>
      ) : (
        <span className="absolute bottom-0.5 text-[8px] font-bold leading-none">{initials}</span>
      )}
    </button>
  )

  if (expanded) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{session.title}</TooltipContent>
    </Tooltip>
  )
}
