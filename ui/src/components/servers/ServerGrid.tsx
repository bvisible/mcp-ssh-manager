import { useTranslation } from 'react-i18next'
import { Monitor, Plus, Upload } from 'lucide-react'
import { useServersStore } from '@/stores/servers.store'
import { CategoryGroup } from './CategoryGroup'
import { Button } from '@/components/ui/button'
import type { ServerConfig } from '@/types/electron'

interface ServerGridProps {
  onEditServer: (server: ServerConfig) => void
  onDeleteServer: (server: ServerConfig) => void
  onAddServer?: () => void
  onImportServers?: () => void
}

export function ServerGrid({
  onEditServer,
  onDeleteServer,
  onAddServer,
  onImportServers
}: ServerGridProps) {
  const { t } = useTranslation()
  const getServersByCategory = useServersStore((s) => s.getServersByCategory)
  const getFilteredServers = useServersStore((s) => s.getFilteredServers)
  const servers = useServersStore((s) => s.servers)
  const searchQuery = useServersStore((s) => s.searchQuery)
  const editMode = useServersStore((s) => s.editMode)
  const viewMode = useServersStore((s) => s.viewMode)
  const filteredServers = getFilteredServers()
  const categories = getServersByCategory()

  // No servers at all — show welcome CTA
  if (servers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 mb-4">
          <Monitor className="h-8 w-8 text-accent" />
        </div>
        <h3 className="text-lg font-semibold">{t('servers.emptyTitle')}</h3>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">
          {t('servers.emptyDescription')}
        </p>
        <div className="mt-6 flex gap-3">
          {onAddServer && (
            <Button onClick={onAddServer}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('servers.addFirst')}
            </Button>
          )}
          {onImportServers && (
            <Button variant="outline" onClick={onImportServers}>
              <Upload className="mr-1.5 h-4 w-4" />
              {t('servers.import')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // Has servers but search/filter returned nothing
  if (filteredServers.length === 0 && searchQuery) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('servers.noResults')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {Array.from(categories.entries()).map(([categoryName, servers]) => (
        <CategoryGroup
          key={categoryName}
          name={categoryName}
          servers={servers}
          editMode={editMode}
          viewMode={viewMode}
          onEditServer={onEditServer}
          onDeleteServer={onDeleteServer}
        />
      ))}
    </div>
  )
}
