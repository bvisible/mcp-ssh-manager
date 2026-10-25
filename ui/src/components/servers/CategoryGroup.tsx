import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings.store'
import type { ServerConfig } from '@/types/electron'
import { ServerCard } from './ServerCard'

interface CategoryGroupProps {
  name: string
  servers: ServerConfig[]
  editMode: boolean
  viewMode: 'grid' | 'list'
  onEditServer: (server: ServerConfig) => void
  onDeleteServer: (server: ServerConfig) => void
}

export const CategoryGroup = React.memo(function CategoryGroup({
  name,
  servers,
  editMode,
  viewMode,
  onEditServer,
  onDeleteServer
}: CategoryGroupProps) {
  const collapsedCategories = useSettingsStore((s) => s.collapsedCategories)
  const toggleCategoryCollapse = useSettingsStore((s) => s.toggleCategoryCollapse)
  const collapsed = collapsedCategories.includes(name)

  return (
    <section className="mb-7">
      {/* Category header. A quiet label with a count, not an orange pill: the
          accent is kept for what needs you, and a group of servers does not. */}
      <button
        onClick={() => toggleCategoryCollapse(name)}
        aria-expanded={!collapsed}
        className="-ml-1.5 mb-3 flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-secondary"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          {name}
        </span>
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          {servers.length}
        </span>
      </button>

      {/* Server cards. A grid that fills the width: a fleet of sixty machines
          laid out as one narrow column per group was a page of empty space. */}
      {!collapsed && (
        <div
          className={cn(
            viewMode === 'grid'
              ? 'grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3'
              : 'flex flex-col overflow-hidden rounded-xl border border-border bg-card'
          )}
        >
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              editMode={editMode}
              viewMode={viewMode}
              onEdit={onEditServer}
              onDelete={onDeleteServer}
            />
          ))}
        </div>
      )}
    </section>
  )
})
