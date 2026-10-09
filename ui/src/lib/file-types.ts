// Centralized file type extension constants and helpers

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])

const CODE_EXTS = new Set([
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'php',
  'swift',
  'kt',
  'dart',
  'vue',
  'svelte',
  'html',
  'css',
  'scss',
  'sh',
  'bash',
  'zsh',
  'sql',
  'graphql'
])

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml',
  'csv',
  'log',
  'conf',
  'cfg',
  'ini',
  'env',
  'gitignore',
  'dockerignore',
  'editorconfig',
  'htaccess',
  'makefile'
])

const DOC_EXTS = new Set([
  'md',
  'txt',
  'pdf',
  'doc',
  'docx',
  'rtf',
  'csv',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml'
])

const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a'])

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm'])

const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z'])

// Extract lowercase extension from filename
function getExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

// Get file type category
export function getFileTypeCategory(
  name: string
): 'image' | 'code' | 'text' | 'doc' | 'audio' | 'video' | 'archive' | 'other' {
  const ext = getExtension(name)

  if (IMAGE_EXTS.has(ext)) return 'image'
  if (CODE_EXTS.has(ext)) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  if (DOC_EXTS.has(ext)) return 'doc'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  return 'other'
}

// Check if file is previewable (image, code, text, or pdf)
export function isPreviewable(name: string): boolean {
  const ext = getExtension(name)
  return (
    IMAGE_EXTS.has(ext) ||
    CODE_EXTS.has(ext) ||
    TEXT_EXTS.has(ext) ||
    (DOC_EXTS.has(ext) && (ext === 'pdf' || ext === 'md' || ext === 'txt' || ext === 'json'))
  )
}

// Check if file is an archive
export function isArchive(name: string): boolean {
  const ext = getExtension(name)
  return ARCHIVE_EXTS.has(ext) || name.endsWith('.tar.gz') || name.endsWith('.tgz')
}

// Detect content type for QuickLookDialog
export function detectContentType(name: string): 'image' | 'text' | 'code' | 'pdf' | 'unsupported' {
  const ext = getExtension(name)

  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (CODE_EXTS.has(ext)) return 'code'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'unsupported'
}
