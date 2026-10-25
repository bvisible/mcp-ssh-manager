import { useState, useCallback } from 'react'
import { Monitor, FolderOpen, Terminal, Pencil, Trash2, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

  // What is open on this machine, in words: two green glyphs in a corner
  // said the same thing to somebody who already knew what they meant.
  const openLabel = hasBrowser && hasTerminal ? 'files and shell open' : hasBrowser ? 'files open' : 'shell open'
  const address = `${server.username}@${server.host}`

  if (viewMode === 'list') {
    return (
      <>
        <div
          className={cn(
            'group flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 transition-colors last:border-b-0',
            'hover:bg-card-hover',
            editMode && 'bg-destructive-light/40'
          )}
        >
          <span
            aria-hidden="true"
            className={cn('h-2 w-2 shrink-0 rounded-full', isConnected ? 'bg-success' : 'bg-border')}
          />
          <span className="w-[160px] shrink-0 truncate text-sm font-bold text-foreground">
            {server.name}
          </span>
          <span className="w-[220px] shrink-0 truncate font-mono text-xs text-muted-foreground">
            {address}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {server.defaultDirectory || ''}
          </span>

          <ServerProtection server={server} />
          {!editMode && isConnected && (
            <span className="shrink-0 text-xs font-bold text-success">{openLabel}</span>
          )}

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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

  // Grid mode (default). The actions are labelled buttons, always visible:
  // two unlabelled glyphs that appeared on hover were the main thing a card is
  // for, and the least discoverable thing on it.
  return (
    <>
      <article
        className={cn(
          'flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-4 transition-shadow',
          'hover:shadow-card-hover',
          editMode && 'border-destructive/30'
        )}
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('h-2 w-2 shrink-0 rounded-full', isConnected ? 'bg-success' : 'bg-border')}
          />
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-foreground">{server.name}</h3>
          {!editMode && isConnected && (
            <span className="shrink-0 text-xs font-bold text-success">{openLabel}</span>
          )}
        </div>
        <p className="truncate font-mono text-[12.5px] text-muted-foreground" title={address}>
          {address}
          {server.defaultDirectory && <> · {server.defaultDirectory}</>}
        </p>

        <ServerProtection server={server} />

        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {editMode ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onEdit(server)}>
                <Pencil className="h-3.5 w-3.5" />
                {t('actions.edit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive-light hover:text-destructive"
                onClick={() => onDelete(server)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('actions.delete')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" aria-label={t('actions.browse')} onClick={openFileBrowser}>
                <FolderOpen className="h-3.5 w-3.5" />
                Files
              </Button>
              <Button variant="outline" size="sm" aria-label="Open a shell" onClick={openSshTerminal}>
                <Terminal className="h-3.5 w-3.5" />
                Shell
              </Button>
            </>
          )}
        </div>
      </article>
      {dialogEl}
    </>
  )
}

/**
 * How far an agent may go on this machine. The neutral case looks neutral and
 * every departure from it has its own colour — read-only in blue, restricted
 * in amber, approval in the accent — so a production box that asks before it
 * acts is recognisable across the room.
 */
function ServerProtection({ server }: { server: ServerConfig }) {
  const approval = server.approval ?? 'never';
  const chip = 'inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs'
  return <div className="flex flex-wrap items-center gap-1.5">
    {server.mode === 'readonly'
      ? <span className={cn(chip, 'bg-info-light font-bold text-info')}>Read only</span>
      : server.mode === 'restricted'
        ? <span className={cn(chip, 'bg-warning-light font-bold text-warning')}>Restricted</span>
        : <span className={cn(chip, 'border border-border text-muted-foreground')}>Unrestricted</span>}
    {approval === 'never'
      ? <span className={cn(chip, 'border border-border text-muted-foreground')}>Approval off</span>
      : <span className={cn(chip, 'bg-accent font-bold text-accent-foreground')}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {approval === 'always' ? 'Approval: every request' : 'Approval: destructive'}
      </span>}
  </div>;
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
            'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
            variant === 'destructive'
              ? 'text-destructive hover:bg-destructive/10'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
          )}
        >
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
