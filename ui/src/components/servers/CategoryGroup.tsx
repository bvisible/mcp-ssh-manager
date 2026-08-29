import React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
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
    <div className="mb-6">
      {/* Category header */}
      <button
        onClick={() => toggleCategoryCollapse(name)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-3 py-1.5 transition-colors',
          'hover:bg-accent/40'
        )}
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            collapsed && '-rotate-90'
          )}
        />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <Badge variant="default" className="ml-1 text-[10px] px-1.5 py-0 h-4">
          {servers.length}
        </Badge>
      </button>

      {/* Server cards */}
      {!collapsed && (
        <div
          className={cn(
            'mt-2',
            viewMode === 'grid' ? 'flex flex-wrap gap-3' : 'flex flex-col gap-0.5'
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
    </div>
  )
})
