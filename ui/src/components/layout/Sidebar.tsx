/**
 * The rail, carried over from TransHub with the AI-chat parts removed.
 *
 * Kept verbatim: the layout, the class names, the active accent bar, the
 * collapse animation, rename-on-double-click, the initials shown when collapsed.
 * Those are the design; rewriting them from a screenshot is how a port stops
 * looking like the thing it was ported from.
 *
 * Removed: Home, the local terminal, the AI chat, the web browser, plugins and
 * settings — none of which exist here — along with the streaming ring and the
 * profile dot they carried.
 */
import { useState, useRef, useEffect } from 'react'
import { Server, Clock, HeartPulse, Radio, Activity, Settings, Menu, FolderOpen, X, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspace, type WorkspaceTab, type ViewId } from '@/stores/workspace'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The screens that always exist, in the order they earn attention. */
const FIXED_VIEWS: { id: ViewId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'waiting', label: 'Waiting', icon: Clock },
  { id: 'health', label: 'Health', icon: HeartPulse },
  { id: 'live', label: 'Live', icon: Radio },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'options', label: 'Options', icon: Settings }
]

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return name.slice(0, 2).charAt(0).toUpperCase() + name.slice(1, 2).toLowerCase()
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

  return (
    <div
      className={cn(
        'sidebar-nav flex h-full flex-col border-r border-border bg-sidebar transition-[width] duration-200',
        sidebarExpanded ? 'w-48' : 'w-12'
      )}
    >
      {/* Toggle button */}
      <button
        onClick={toggleExpanded}
        aria-label={sidebarExpanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
        className="no-drag mt-2 mb-3 ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-accent transition-colors"
      >
        <Menu
          className={cn(
            'h-4 w-4 text-muted-foreground transition-all duration-200',
            sidebarExpanded && 'rotate-45 scale-0 opacity-0 absolute'
          )}
        />
        <X
          className={cn(
            'h-4 w-4 text-muted-foreground transition-all duration-200',
            sidebarExpanded
              ? 'rotate-0 scale-100 opacity-100'
              : '-rotate-45 scale-0 opacity-0 absolute'
          )}
        />
      </button>

      {/* Fixed navigation */}
      <nav className="flex flex-col items-center gap-1 px-1">
        {FIXED_VIEWS.map((item) => (
          <SidebarItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={activeTabId === null && view === item.id}
            expanded={sidebarExpanded}
            badge={item.id === 'waiting' && pendingCount > 0 ? pendingCount : undefined}
            onClick={() => setView(item.id)}
          />
        ))}
      </nav>

      {/* Dynamic sessions */}
      {tabs.length > 0 && (
        <>
          <div className="mx-2 my-2 border-t border-border" />
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-1 scrollbar-none">
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
        </>
      )}

      {tabs.length === 0 && <div className="flex-1" />}
    </div>
  )
}

function SidebarItem({
  icon: Icon,
  label,
  active,
  expanded,
  onClick,
  badge
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active: boolean
  expanded: boolean
  onClick: () => void
  badge?: number
}) {
  const button = (
    <button
      onClick={onClick}
      className={cn(
        'no-drag relative flex h-9 items-center gap-2.5 rounded-lg transition-colors w-full pl-[11px]',
        active
          ? 'bg-accent text-primary'
          : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
      )}
    >
      {active && (
        <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <span className="relative shrink-0">
        <Icon className="h-[18px] w-[18px]" />
        {!expanded && badge !== undefined && (
          <span className="absolute -right-1 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-destructive px-0.5 text-[7px] font-bold leading-none text-destructive-foreground">
            {badge}
          </span>
        )}
      </span>
      {expanded && <span className="flex-1 truncate text-left text-xs font-medium">{label}</span>}
      {expanded && badge !== undefined && (
        <span className="mr-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 px-1 text-[10px] font-medium text-destructive">
          {badge}
        </span>
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
  const initials = getInitials(session.title)

  const button = (
    <button
      onClick={onActivate}
      className={cn(
        'no-drag group relative flex h-9 items-center gap-2 rounded-lg transition-colors w-full pl-[11px]',
        expanded && 'pr-1',
        active
          ? 'bg-accent text-primary'
          : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
      )}
    >
      {active && (
        <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary" />
      )}
      <span className="relative shrink-0">
        <Icon className="h-[18px] w-[18px]" />
        {!expanded && session.badge && session.badge > 1 && (
          <span className="absolute -right-1 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[7px] font-bold leading-none text-primary-foreground">
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
              className="flex-1 min-w-0 bg-transparent text-xs font-medium outline-none border-b border-primary"
            />
          ) : (
            <span
              className="flex-1 truncate text-left text-xs font-medium"
              onDoubleClick={handleDoubleClick}
            >
              {session.title}
            </span>
          )}
          {session.badge && session.badge > 1 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-medium text-primary">
              {session.badge}
            </span>
          )}
          <span
            role="button"
            tabIndex={0}
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
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-accent/30 transition-all cursor-pointer"
          >
            <X className="h-3 w-3" />
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
