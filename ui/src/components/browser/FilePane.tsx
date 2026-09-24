import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RefreshCw,
  ArrowUp,
  FolderOpen,
  FolderPlus,
  Upload,
  Download,
  Eye,
  EyeOff,
  Terminal,
  ClipboardCopy,
  Home,
  HardDrive,
  Heart
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Breadcrumb } from './Breadcrumb'
import { FilePaneContextMenu } from './FilePaneContextMenu'
import { FilePaneRow } from './FilePaneRow'
import { cn } from '@/lib/utils'

export interface FileItem {
  name: string
  path: string
  size: number
  isDirectory: boolean
  isSymlink: boolean
  modifyTime: number
  permissions?: number
  owner?: number
  group?: number
}

type SortField = 'name' | 'size' | 'modified'
type SortDir = 'asc' | 'desc'

// DnD data format key
const DND_FILE_TYPE = 'application/x-transhub-files'

interface FilePaneProps {
  title: string
  isLocal: boolean
  files: FileItem[]
  currentPath: string
  loading: boolean
  selectedFiles: Set<string>
  onNavigate: (path: string) => void
  onRefresh: () => void
  onSelect: (path: string, multi: boolean, range: boolean) => void
  onOpen: (file: FileItem) => void
  onCreateFolder: () => void
  onCreateFile?: () => void
  onDelete: (files: FileItem[]) => void
  onRename: (file: FileItem) => void
  onTransfer?: (files: FileItem[]) => void
  transferLabel?: string
  onShowInFinder?: (path: string) => void
  onDropFiles?: (files: FileItem[], targetDir: string) => void
  onOpenTerminal?: () => void
  onCompress?: (files: FileItem[]) => void
  onExtract?: (file: FileItem) => void
  onPreview?: (file: FileItem) => void
  onInspect?: (file: FileItem) => void
  onOpenInEditor?: (file: FileItem) => void
  onOpenInCode?: (file: FileItem) => void
  // Toolbar navigation buttons
  onGoHome?: () => void
  onGoRoot?: () => void
  onGoDefaultDir?: () => void
  defaultDirPath?: string | null
  onSetDefaultDir?: () => void
  onCopyPath?: () => void
  onOpenTerminalHere?: () => void
  onNativeFileDrop?: (files: File[], targetDir: string) => void
}

export const FilePane = memo(function FilePane({
  title,
  isLocal,
  files,
  currentPath,
  loading,
  selectedFiles,
  onNavigate,
  onRefresh,
  onSelect,
  onOpen,
  onCreateFolder,
  onCreateFile,
  onDelete,
  onRename,
  onTransfer,
  transferLabel,
  onShowInFinder,
  onDropFiles,
  onOpenTerminal,
  onCompress,
  onExtract,
  onPreview,
  onInspect,
  onOpenInEditor,
  onOpenInCode,
  onGoHome,
  onGoRoot,
  onGoDefaultDir,
  defaultDirPath,
  onSetDefaultDir,
  onCopyPath,
  onOpenTerminalHere,
  onNativeFileDrop
}: FilePaneProps) {
  const { t } = useTranslation()
  const [showHidden, setShowHidden] = useState(false)
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [rightClickedFile, setRightClickedFile] = useState<FileItem | undefined>(undefined)
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        !containerRef.current?.contains(document.activeElement) &&
        containerRef.current !== document.activeElement
      )
        return

      // Space = Quick Look
      if (e.key === ' ' && onPreview && selectedFiles.size === 1) {
        e.preventDefault()
        const file = files.find((f) => selectedFiles.has(f.path))
        if (file && !file.isDirectory) onPreview(file)
      }
      // Cmd+R = Refresh
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        onRefresh()
      }
      // Cmd+Shift+N = New folder
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        onCreateFolder()
      }
      // Cmd+N = New file
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'n' && onCreateFile) {
        e.preventDefault()
        onCreateFile()
      }
      // Cmd+I = Inspector
      if ((e.metaKey || e.ctrlKey) && e.key === 'i' && onInspect && selectedFiles.size === 1) {
        e.preventDefault()
        const file = files.find((f) => selectedFiles.has(f.path))
        if (file) onInspect(file)
      }
      // Cmd+Backspace = Delete
      if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && selectedFiles.size > 0) {
        e.preventDefault()
        const selectedItems = files.filter((f) => selectedFiles.has(f.path))
        if (selectedItems.length > 0) onDelete(selectedItems)
      }
      // Cmd+C = Copy path
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selectedFiles.size === 1) {
        const file = files.find((f) => selectedFiles.has(f.path))
        if (file) navigator.clipboard.writeText(file.path)
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [
    selectedFiles,
    files,
    onPreview,
    onRefresh,
    onCreateFolder,
    onCreateFile,
    onInspect,
    onDelete
  ])

  const filteredFiles = useMemo(
    () => files.filter((f) => showHidden || !f.name.startsWith('.')),
    [files, showHidden]
  )

  const sortedFiles = useMemo(
    () =>
      [...filteredFiles].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        let cmp = 0
        switch (sortField) {
          case 'name':
            cmp = a.name.localeCompare(b.name)
            break
          case 'size':
            cmp = a.size - b.size
            break
          case 'modified':
            cmp = a.modifyTime - b.modifyTime
            break
        }
        return sortDir === 'asc' ? cmp : -cmp
      }),
    [filteredFiles, sortField, sortDir]
  )

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const goUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/'
    onNavigate(parent)
  }

  // ===== Drag & Drop =====
  const handleDragStart = useCallback(
    (e: React.DragEvent, file: FileItem) => {
      const filesToDrag = selectedFiles.has(file.path)
        ? files.filter((f) => selectedFiles.has(f.path))
        : [file]

      e.dataTransfer.setData(
        DND_FILE_TYPE,
        JSON.stringify({
          files: filesToDrag,
          source: isLocal ? 'local' : 'remote',
          sourcePath: currentPath
        })
      )
      e.dataTransfer.effectAllowed = 'copy'

      // Custom drag image
      const dragEl = document.createElement('div')
      dragEl.className =
        'fixed bg-card border border-border rounded-lg px-3 py-1.5 text-xs shadow-lg flex items-center gap-2 pointer-events-none'
      dragEl.innerHTML = `<span>${filesToDrag.length} item${filesToDrag.length > 1 ? 's' : ''}</span>`
      dragEl.style.position = 'absolute'
      dragEl.style.top = '-1000px'
      document.body.appendChild(dragEl)
      e.dataTransfer.setDragImage(dragEl, 0, 0)
      setTimeout(() => document.body.removeChild(dragEl), 0)
    },
    [selectedFiles, files, isLocal, currentPath]
  )

  const handleDragOver = useCallback((e: React.DragEvent, targetPath?: string) => {
    e.preventDefault()
    e.stopPropagation()

    // Accept both internal cross-pane drops and native OS file drops (Finder/Explorer)
    if (e.dataTransfer.types.includes(DND_FILE_TYPE) || e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy'
      if (targetPath) setDragOverTarget(targetPath)
      else setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOverTarget(null)
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, targetDir?: string) => {
      e.preventDefault()
      e.stopPropagation()
      setDragOverTarget(null)
      setIsDragOver(false)

      // 1. Internal cross-pane drop (existing logic)
      const data = e.dataTransfer.getData(DND_FILE_TYPE)
      if (data) {
        try {
          const { files: draggedFiles, source } = JSON.parse(data) as {
            files: FileItem[]
            source: 'local' | 'remote'
            sourcePath: string
          }

          // Only allow cross-pane transfers
          const thisPane = isLocal ? 'local' : 'remote'
          if (source === thisPane) return

          const dropDir = targetDir || currentPath
          onDropFiles?.(draggedFiles, dropDir)
        } catch {
          // Invalid data
        }
        return
      }

      // 2. Native OS file drop (Finder / Explorer)
      if (e.dataTransfer.files.length > 0) {
        const nativeFiles = Array.from(e.dataTransfer.files)
        const dropDir = targetDir || currentPath
        onNativeFileDrop?.(nativeFiles, dropDir)
      }
    },
    [isLocal, currentPath, onDropFiles, onNativeFileDrop]
  )

  // Context menu handler for rows — selects file if not already selected
  const handleRowContextMenu = useCallback(
    (file: FileItem) => {
      if (!selectedFiles.has(file.path)) {
        onSelect(file.path, false, false)
      }
      setRightClickedFile(file)
    },
    [selectedFiles, onSelect]
  )

  const selectedFileItems = useMemo(
    () => sortedFiles.filter((f) => selectedFiles.has(f.path)),
    [sortedFiles, selectedFiles]
  )

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={cn(
        'flex h-full flex-col outline-none',
        isDragOver && 'ring-2 ring-inset ring-primary'
      )}
      onDragOver={(e) => handleDragOver(e)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e)}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShowHidden(!showHidden)}
            title={showHidden ? t('files.hideHidden') : t('files.showHidden')}
          >
            {showHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCreateFolder}
            title={t('files.newFolder') + ' (⇧⌘N)'}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
          {onTransfer && selectedFileItems.length > 0 && (
            <Button
              variant="default"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={() => onTransfer(selectedFileItems)}
            >
              {isLocal ? <Upload className="h-3 w-3" /> : <Download className="h-3 w-3" />}
              {transferLabel || (isLocal ? t('files.upload') : t('files.download'))} (
              {selectedFileItems.length})
            </Button>
          )}
        </div>
      </div>

      {/* Navigation bar */}
      <div className="flex items-center gap-0.5 border-b border-border px-3 py-1">
        <Button variant="ghost" size="icon-sm" onClick={goUp} title={t('files.goUp')}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        {onGoHome && (
          <Button variant="ghost" size="icon-sm" onClick={onGoHome} title={t('files.home')}>
            <Home className="h-3.5 w-3.5" />
          </Button>
        )}
        {onGoRoot && (
          <Button variant="ghost" size="icon-sm" onClick={onGoRoot} title={t('files.root')}>
            <HardDrive className="h-3.5 w-3.5" />
          </Button>
        )}
        {onGoDefaultDir && defaultDirPath && (
          <Button variant="ghost" size="icon-sm" onClick={onGoDefaultDir} title={defaultDirPath}>
            <FolderOpen className="h-3.5 w-3.5 text-primary" />
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <Breadcrumb path={currentPath} isLocal={isLocal} onNavigate={onNavigate} />
        </div>
        {onCopyPath && (
          <Button variant="ghost" size="icon-sm" onClick={onCopyPath} title={t('files.copyPath')}>
            <ClipboardCopy className="h-3.5 w-3.5" />
          </Button>
        )}
        {onOpenTerminalHere && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenTerminalHere}
            title={t('files.openTerminal')}
          >
            <Terminal className="h-3.5 w-3.5" />
          </Button>
        )}
        {onSetDefaultDir && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onSetDefaultDir}
            title={t('files.setDefault')}
            className={currentPath === defaultDirPath ? 'text-red-500' : ''}
          >
            <Heart
              className={cn('h-3.5 w-3.5', currentPath === defaultDirPath && 'fill-current')}
            />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          disabled={loading}
          title={t('files.refresh') + ' (⌘R)'}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* File list with context menu */}
      <FilePaneContextMenu
        selectedFiles={selectedFiles}
        files={sortedFiles}
        isLocal={isLocal}
        rightClickedFile={rightClickedFile}
        currentPath={currentPath}
        onOpen={onOpen}
        onDelete={onDelete}
        onRename={onRename}
        onTransfer={onTransfer}
        onCompress={onCompress}
        onExtract={onExtract}
        onPreview={onPreview}
        onInspect={onInspect}
        onShowInFinder={onShowInFinder}
        onCreateFolder={onCreateFolder}
        onCreateFile={onCreateFile}
        onRefresh={onRefresh}
        onOpenTerminal={onOpenTerminal}
        onOpenInEditor={onOpenInEditor}
        onOpenInCode={onOpenInCode}
        t={t}
      >
        <div
          className="flex-1 overflow-auto"
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              setRightClickedFile(undefined)
            }
          }}
        >
          {/* Column headers */}
          <div className="sticky top-0 z-10 flex items-center border-b border-border bg-muted text-[10px] text-muted-foreground font-medium">
            <button
              className="flex-1 px-3 py-1 text-left hover:text-foreground transition-colors"
              onClick={() => handleSort('name')}
            >
              {t('files.columnName')}{' '}
              {sortField === 'name' && (
                <span className="ml-0.5 text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
            <button
              className="w-20 px-3 py-1 text-right hover:text-foreground transition-colors"
              onClick={() => handleSort('size')}
            >
              {t('files.columnSize')}{' '}
              {sortField === 'size' && (
                <span className="ml-0.5 text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
            <button
              className="w-36 px-3 py-1 text-left hover:text-foreground transition-colors"
              onClick={() => handleSort('modified')}
            >
              {t('files.columnModified')}{' '}
              {sortField === 'modified' && (
                <span className="ml-0.5 text-[9px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
          </div>

          {/* File rows */}
          {sortedFiles.map((file) => (
            <FilePaneRow
              key={file.path}
              file={file}
              isSelected={selectedFiles.has(file.path)}
              isDragTarget={dragOverTarget === file.path && file.isDirectory}
              onSelect={onSelect}
              onOpen={onOpen}
              onContextMenu={handleRowContextMenu}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              t={t}
            />
          ))}

          {sortedFiles.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FolderOpen className="h-10 w-10 mb-2 opacity-20" />
              <p className="text-xs">{t('files.emptyDirectory')}</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      </FilePaneContextMenu>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border px-2 py-0.5 text-[10px] text-muted-foreground">
        <span>
          {filteredFiles.length} {t('files.statusItems')}
          {!showHidden && files.length !== filteredFiles.length
            ? ` (${files.length - filteredFiles.length} ${t('files.statusHidden')})`
            : ''}
        </span>
        {selectedFiles.size > 0 && (
          <span>
            {selectedFiles.size} {t('files.statusSelected')}
          </span>
        )}
      </div>
    </div>
  )
})
