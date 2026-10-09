import type { TFunction } from 'i18next'
import {
  RefreshCw,
  FolderOpen,
  File,
  FolderPlus,
  Upload,
  Download,
  Trash2,
  Eye,
  Pencil,
  Terminal,
  FileArchive,
  ClipboardCopy,
  ExternalLink,
  Info,
  FileCode,
  SquareTerminal
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { isArchive, isPreviewable } from '@/lib/file-types'
import type { FileItem } from './FilePane'

interface FilePaneContextMenuProps {
  selectedFiles: Set<string>
  files: FileItem[]
  isLocal: boolean
  rightClickedFile: FileItem | undefined
  currentPath: string
  // Callbacks
  onOpen: (file: FileItem) => void
  onDelete: (files: FileItem[]) => void
  onRename: (file: FileItem) => void
  onTransfer?: (files: FileItem[]) => void
  onCompress?: (files: FileItem[]) => void
  onExtract?: (file: FileItem) => void
  onPreview?: (file: FileItem) => void
  onInspect?: (file: FileItem) => void
  onShowInFinder?: (path: string) => void
  onCopyPath?: () => void
  onCreateFolder: () => void
  onCreateFile?: () => void
  onRefresh: () => void
  onOpenTerminal?: () => void
  onOpenInEditor?: (file: FileItem) => void
  onOpenInCode?: (file: FileItem) => void
  t: TFunction
  children: React.ReactNode
}

export function FilePaneContextMenu({
  selectedFiles,
  files,
  isLocal,
  rightClickedFile,
  currentPath,
  onOpen,
  onDelete,
  onRename,
  onTransfer,
  onCompress,
  onExtract,
  onPreview,
  onInspect,
  onShowInFinder,
  onCreateFolder,
  onCreateFile,
  onRefresh,
  onOpenTerminal,
  onOpenInEditor,
  onOpenInCode,
  t,
  children
}: FilePaneContextMenuProps) {
  // Resolve selected file items for multi-selection actions
  const selectedFileItems = files.filter((f) => selectedFiles.has(f.path))

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        {rightClickedFile ? (
          <>
            <ContextMenuItem onClick={() => onOpen(rightClickedFile)}>
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              {t('files.contextOpen')}
            </ContextMenuItem>
            {onOpenInEditor && (isLocal || !rightClickedFile.isDirectory) && (
              <ContextMenuItem onClick={() => onOpenInEditor(rightClickedFile)}>
                <FileCode className="mr-2 h-3.5 w-3.5" />
                {t('files.openInEditor')}
              </ContextMenuItem>
            )}
            {onOpenInCode && isLocal && rightClickedFile.isDirectory && (
              <ContextMenuItem onClick={() => onOpenInCode(rightClickedFile)}>
                <SquareTerminal className="mr-2 h-3.5 w-3.5" />
                {t('files.openInCode')}
              </ContextMenuItem>
            )}
            {!rightClickedFile.isDirectory && onPreview && isPreviewable(rightClickedFile.name) && (
              <ContextMenuItem onClick={() => onPreview(rightClickedFile)}>
                <Eye className="mr-2 h-3.5 w-3.5" />
                {t('files.contextQuickLook')}
                <ContextMenuShortcut>Space</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            {isLocal && onShowInFinder && (
              <ContextMenuItem onClick={() => onShowInFinder(rightClickedFile.path)}>
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {t('files.contextShowInFinder')}
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => navigator.clipboard.writeText(rightClickedFile.path)}>
              <ClipboardCopy className="mr-2 h-3.5 w-3.5" />
              {t('files.contextCopyPath')}
              <ContextMenuShortcut>⌘C</ContextMenuShortcut>
            </ContextMenuItem>
            {onInspect && (
              <ContextMenuItem onClick={() => onInspect(rightClickedFile)}>
                <Info className="mr-2 h-3.5 w-3.5" />
                {t('files.contextGetInfo')}
                <ContextMenuShortcut>⌘I</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            {onTransfer && (
              <>
                <ContextMenuItem
                  onClick={() =>
                    onTransfer(
                      selectedFileItems.length > 0 ? selectedFileItems : [rightClickedFile]
                    )
                  }
                >
                  {isLocal ? (
                    <Upload className="mr-2 h-3.5 w-3.5" />
                  ) : (
                    <Download className="mr-2 h-3.5 w-3.5" />
                  )}
                  {`${isLocal ? t('files.contextUpload') : t('files.contextDownload')}${selectedFileItems.length > 1 ? ` (${selectedFileItems.length})` : ''}`}
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem onClick={() => onRename(rightClickedFile)}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              {t('files.contextRename')}
            </ContextMenuItem>
            {!rightClickedFile.isDirectory && onCompress && (
              <ContextMenuItem
                onClick={() =>
                  onCompress(selectedFileItems.length > 0 ? selectedFileItems : [rightClickedFile])
                }
              >
                <FileArchive className="mr-2 h-3.5 w-3.5" />
                {t('files.contextCompressZip')}
              </ContextMenuItem>
            )}
            {!rightClickedFile.isDirectory && isArchive(rightClickedFile.name) && onExtract && (
              <ContextMenuItem onClick={() => onExtract(rightClickedFile)}>
                <FileArchive className="mr-2 h-3.5 w-3.5" />
                {t('files.contextExtractZip')}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() =>
                onDelete(selectedFileItems.length > 0 ? selectedFileItems : [rightClickedFile])
              }
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {`${t('files.contextDelete')}${selectedFileItems.length > 1 ? ` (${selectedFileItems.length})` : ''}`}
              <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={onCreateFolder}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              {t('files.contextNewFolder')}
              <ContextMenuShortcut>⇧⌘N</ContextMenuShortcut>
            </ContextMenuItem>
            {onCreateFile && (
              <ContextMenuItem onClick={onCreateFile}>
                <File className="mr-2 h-3.5 w-3.5" />
                {t('files.contextNewFile')}
                <ContextMenuShortcut>⌘N</ContextMenuShortcut>
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => navigator.clipboard.writeText(currentPath)}>
              <ClipboardCopy className="mr-2 h-3.5 w-3.5" />
              {t('files.contextCopyPath')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onRefresh}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              {t('files.contextRefresh')}
              <ContextMenuShortcut>⌘R</ContextMenuShortcut>
            </ContextMenuItem>
            {onOpenTerminal && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={onOpenTerminal}>
                  <Terminal className="mr-2 h-3.5 w-3.5" />
                  {t('files.contextOpenTerminal')}
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
