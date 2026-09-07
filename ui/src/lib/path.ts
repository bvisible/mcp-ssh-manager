/** Join path segments with forward slashes */
export function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/** Get parent directory */
export function dirname(path: string): string {
  const parent = path.split('/').slice(0, -1).join('/')
  return parent || '/'
}

/** Get base file name */
export function basename(path: string): string {
  return path.split('/').pop() || ''
}

/** Get file extension */
export function extname(path: string): string {
  const name = basename(path)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.substring(idx) : ''
}
