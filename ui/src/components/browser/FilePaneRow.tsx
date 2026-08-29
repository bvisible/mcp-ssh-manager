import { memo } from 'react'
import type { TFunction } from 'i18next'
import {
  FolderOpen,
  File,
  FileText,
  Image,
  FileCode,
  Music,
  Video,
  FileArchive
} from 'lucide-react'
import { cn, formatFileSize, formatDate } from '@/lib/utils'
import { getFileTypeCategory } from '@/lib/file-types'
import type { FileItem } from './FilePane'

function getFileIcon(file: FileItem) {
  if (file.isDirectory) return <FolderOpen className="h-3.5 w-3.5 text-primary shrink-0" />
  const category = getFileTypeCategory(file.name)
  switch (category) {
    case 'image':
      return <Image className="h-3.5 w-3.5 text-green-500 shrink-0" />
    case 'code':
      return <FileCode className="h-3.5 w-3.5 text-blue-400 shrink-0" />
    case 'doc':
    case 'text':
      return <FileText className="h-3.5 w-3.5 text-orange-400 shrink-0" />
    case 'audio':
      return <Music className="h-3.5 w-3.5 text-purple-400 shrink-0" />
    case 'video':
      return <Video className="h-3.5 w-3.5 text-red-400 shrink-0" />
    case 'archive':
      return <FileArchive className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
    default:
      return <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  }
}

interface FilePaneRowProps {
  file: FileItem
  isSelected: boolean
  isDragTarget: boolean
  onSelect: (path: string, multi: boolean, range: boolean) => void
  onOpen: (file: FileItem) => void
  onContextMenu: (file: FileItem) => void
  onDragStart: (e: React.DragEvent, file: FileItem) => void
  onDragOver: (e: React.DragEvent, targetPath?: string) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, targetDir?: string) => void
  t: TFunction
}

export const FilePaneRow = memo(function FilePaneRow({
  file,
  isSelected,
  isDragTarget,
  onSelect,
  onOpen,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  t
}: FilePaneRowProps) {
  const handleClick = (e: React.MouseEvent) => {
    onSelect(file.path, e.metaKey || e.ctrlKey, e.shiftKey)
  }

  return (
    <div
      role="row"
      tabIndex={0}
      draggable
      className={cn(
        'flex items-center text-xs cursor-pointer transition-colors',
        'border-b border-border-subtle',
        isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent/30',
        isDragTarget && 'ring-2 ring-inset ring-primary bg-accent'
      )}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(file)
        if (e.key === ' ') {
          e.preventDefault()
          handleClick(e as unknown as React.MouseEvent)
        }
      }}
      onDoubleClick={() => onOpen(file)}
      onContextMenu={() => onContextMenu(file)}
      onDragStart={(e) => onDragStart(e, file)}
      onDragOver={(e) => (file.isDirectory ? onDragOver(e, file.path) : undefined)}
      onDragLeave={onDragLeave}
      onDrop={(e) => (file.isDirectory ? onDrop(e, file.path) : undefined)}
    >
      <div className="flex flex-1 items-center gap-1.5 px-2 py-1 min-w-0">
        {getFileIcon(file)}
        <span className="truncate">{file.name}</span>
        {file.isSymlink && (
          <span className="text-[9px] text-muted-foreground bg-muted px-1 rounded">
            {t('files.statusLink')}
          </span>
        )}
      </div>
      <div className="w-20 px-2 py-1 text-right text-muted-foreground tabular-nums">
        {file.isDirectory ? '--' : formatFileSize(file.size)}
      </div>
      <div className="w-36 px-2 py-1 text-muted-foreground">{formatDate(file.modifyTime)}</div>
    </div>
  )
})
