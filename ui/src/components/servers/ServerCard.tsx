import { useState, useCallback } from 'react'
import { Monitor, FolderOpen, Terminal, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@/components/ui/alert-dialog'
import type { ServerConfig } from '@/types/electron'
import { useWorkspaceStore } from '@/stores/workspace.store'
import { generateId } from '@/lib/utils'

interface ServerCardProps {
  server: ServerConfig
  editMode: boolean
  viewMode: 'grid' | 'list'
  onEdit: (server: ServerConfig) => void
  onDelete: (server: ServerConfig) => void
}

export function ServerCard({ server, editMode, viewMode, onEdit, onDelete }: ServerCardProps) {
  const { t } = useTranslation()
  const { addTab, activateTab } = useWorkspaceStore()
  const [dupDialog, setDupDialog] = useState<{
    type: 'dual-browser' | 'ssh-terminal'
    existingId: string
  } | null>(null)

  // Connection status selectors (individual selectors avoid unnecessary re-renders)
  const hasBrowser = useWorkspaceStore((s) =>
    s.tabs.some((t) => t.serverId === server.id && t.type === 'dual-browser')
  )
  const hasTerminal = useWorkspaceStore((s) =>
    s.tabs.some((t) => t.serverId === server.id && t.type === 'ssh-terminal')
  )
  const browserTabId = useWorkspaceStore(
    (s) => s.tabs.find((t) => t.serverId === server.id && t.type === 'dual-browser')?.id
  )
  const terminalTabId = useWorkspaceStore(
    (s) => s.tabs.find((t) => t.serverId === server.id && t.type === 'ssh-terminal')?.id
  )
  const isConnected = hasBrowser || hasTerminal

  const openOrPrompt = useCallback(
    (type: 'dual-browser' | 'ssh-terminal') => {
      const existingId = type === 'dual-browser' ? browserTabId : terminalTabId
      if (existingId) {
        setDupDialog({ type, existingId })
      } else {
        addTab({
          id: generateId(),
          type,
          title: server.name,
          serverId: server.id
        })
      }
    },
    [browserTabId, terminalTabId, server.name, server.id, addTab]
  )

  const openFileBrowser = useCallback(() => openOrPrompt('dual-browser'), [openOrPrompt])
  const openSshTerminal = useCallback(() => openOrPrompt('ssh-terminal'), [openOrPrompt])

  const dupDialogLabel =
    dupDialog?.type === 'dual-browser' ? t('actions.browse') : t('actions.connect')

  const handleGoExisting = useCallback(() => {
    if (dupDialog) activateTab(dupDialog.existingId)
    setDupDialog(null)
  }, [dupDialog, activateTab])

  const handleOpenNew = useCallback(() => {
    if (dupDialog) {
      // Bypass store dedup by adding directly
      const { tabs } = useWorkspaceStore.getState()
      const newTab = {
        id: generateId(),
        type: dupDialog.type,
        title: server.name,
        serverId: server.id,
        closable: true as const
      }
      useWorkspaceStore.setState({ tabs: [...tabs, newTab], activeTabId: newTab.id })
    }
    setDupDialog(null)
  }, [dupDialog, server.name, server.id])

  const dialogEl = (
    <AlertDialog open={!!dupDialog} onOpenChange={(open) => !open && setDupDialog(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('servers.dupDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('servers.dupDialog.description', { name: server.name, type: dupDialogLabel })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleGoExisting}>
            {t('servers.dupDialog.goExisting')}
          </AlertDialogAction>
          <AlertDialogAction onClick={handleOpenNew}>
            {t('servers.dupDialog.openNew')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  if (viewMode === 'list') {
    return (
      <>
        <div
          className={cn(
            'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
            'hover:bg-accent/30',
            editMode && 'ring-1 ring-destructive/30'
          )}
        >
          <div className="flex flex-1 items-center gap-3">
            <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="w-[140px] truncate text-sm font-medium text-foreground">
              {server.name}
            </span>
            <span className="w-[200px] truncate text-xs text-muted-foreground">
              {server.username}@{server.host}
            </span>
            <span className="flex-1 truncate text-xs text-muted-foreground/70">
              {server.defaultDirectory || ''}
            </span>
          </div>

          {/* Connection status indicator */}
          {!editMode && isConnected && (
            <ConnectionIndicator hasBrowser={hasBrowser} hasTerminal={hasTerminal} />
          )}

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {editMode ? (
              <>
                <ActionButton
                  icon={Pencil}
                  tooltip={t('actions.edit')}
                  onClick={() => onEdit(server)}
                />
                <ActionButton
                  icon={Trash2}
                  tooltip={t('actions.delete')}
                  onClick={() => onDelete(server)}
                  variant="destructive"
                />
              </>
            ) : (
              <>
                <ActionButton
                  icon={FolderOpen}
                  tooltip={t('actions.browse')}
                  onClick={openFileBrowser}
                />
                <ActionButton
                  icon={Terminal}
                  tooltip={t('actions.connect')}
                  onClick={openSshTerminal}
                />
              </>
            )}
          </div>
        </div>
        {dialogEl}
      </>
    )
  }

  // Grid mode (default)
  return (
    <>
      <div
        className={cn(
          'group relative flex w-[200px] flex-col rounded-lg bg-card shadow-card transition-all',
          'hover:shadow-card-hover hover:ring-1 hover:ring-primary/30',
          editMode && 'ring-1 ring-destructive/30'
        )}
      >
        {/* Connection status indicator - top right */}
        {!editMode && isConnected && (
          <div className="absolute right-2 top-2 z-10">
            <ConnectionIndicator hasBrowser={hasBrowser} hasTerminal={hasTerminal} />
          </div>
        )}

        <div>
          <div className="flex items-start gap-2.5 p-3 pb-2">
            <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{server.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {server.username}@{server.host}
              </p>
              {server.defaultDirectory && (
                <p className="truncate text-xs text-muted-foreground/70">
                  {server.defaultDirectory}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-0.5 px-2 pb-2">
            {editMode ? (
              <>
                <ActionButton
                  icon={Pencil}
                  tooltip={t('actions.edit')}
                  onClick={() => onEdit(server)}
                />
                <ActionButton
                  icon={Trash2}
                  tooltip={t('actions.delete')}
                  onClick={() => onDelete(server)}
                  variant="destructive"
                />
              </>
            ) : (
              <>
                <ActionButton
                  icon={FolderOpen}
                  tooltip={t('actions.browse')}
                  onClick={openFileBrowser}
                />
                <ActionButton
                  icon={Terminal}
                  tooltip={t('actions.connect')}
                  onClick={openSshTerminal}
                />
              </>
            )}
          </div>
        </div>
      </div>
      {dialogEl}
    </>
  )
}

// Connection status indicator
function ConnectionIndicator({
  hasBrowser,
  hasTerminal
}: {
  hasBrowser: boolean
  hasTerminal: boolean
}) {
  const { t } = useTranslation()

  const tooltipText =
    hasBrowser && hasTerminal
      ? t('servers.status.browserAndTerminal')
      : hasBrowser
        ? t('servers.status.browserActive')
        : t('servers.status.terminalActive')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1">
          {hasBrowser && <FolderOpen className="h-3 w-3 text-green-500" />}
          {hasTerminal && <Terminal className="h-3 w-3 text-green-500" />}
        </div>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  )
}

// Shared action button component
function ActionButton({
  icon: Icon,
  tooltip,
  onClick,
  variant
}: {
  icon: typeof Monitor
  tooltip: string
  onClick: () => void
  variant?: 'destructive'
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          // The tooltip is the only label these carry, and a tooltip is not read
          // by a screen reader or reachable by keyboard — without this the
          // buttons announce as nothing at all.
          aria-label={tooltip}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            variant === 'destructive'
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
