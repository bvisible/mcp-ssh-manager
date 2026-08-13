import path from 'path';

/**
 * Convert a local path into the POSIX-style path expected by an MSYS2 rsync.
 *
 * Node must keep using the native Windows path for filesystem checks. Only the
 * argument handed to rsync is converted, otherwise a drive prefix such as
 * `C:` is parsed by rsync as a remote host name.
 *
 * @param {string} localPath
 * @param {{ platform?: NodeJS.Platform, cwd?: string }} [options]
 * @returns {string}
 */
export function toRsyncLocalPath(localPath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return localPath;
  if (localPath.length === 0) {
    throw new Error('Local rsync path cannot be empty');
  }

  const cwd = options.cwd ?? process.cwd();

  // Already in MSYS2 form — a drive mount (/c/project) or a UNC share
  // (//server/share). Pass it through untouched instead of resolving it against
  // the current drive, which would produce /c/c/project. Windows users hit this
  // bug before it was fixed and worked around it by pre-converting their paths;
  // silently double-mounting those would trade one broken path for another.
  // The test is deliberately narrow: only a single-letter first segment is a
  // drive mount, so a genuine rooted path such as /Users/me still converts.
  if (/^\/[A-Za-z](\/|$)/.test(localPath) || localPath.startsWith('//')) {
    return localPath;
  }

  const preserveTrailingSeparator = /[\\/]$/.test(localPath);
  let nativePath = localPath;

  // Normalize Windows extended-length paths before resolving them. MSYS2
  // understands drive mounts and UNC paths, but not the \\?\ device prefix.
  if (/^\\\\\?\\UNC\\/i.test(nativePath)) {
    nativePath = `\\\\${nativePath.slice(8)}`;
  } else if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(nativePath)) {
    nativePath = nativePath.slice(4);
  } else if (/^\\\\\?\\/.test(nativePath)) {
    throw new Error(`Unsupported Windows device path for rsync: ${localPath}`);
  }

  // Relative paths already work in MSYS2/Cygwin and must remain relative to
  // the MCP process working directory. Only normalize their separators.
  // Drive-relative paths (C:folder) still contain rsync's remote separator, so
  // resolve those before conversion as well.
  if (!path.win32.isAbsolute(nativePath) && !/^[A-Za-z]:/.test(nativePath)) {
    return nativePath.replaceAll('\\', '/');
  }

  const absolutePath = path.win32.resolve(cwd, nativePath);
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(absolutePath);
  let rsyncPath;

  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    rsyncPath = `/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`;
  } else if (absolutePath.startsWith('\\\\')) {
    rsyncPath = `//${absolutePath.slice(2).replaceAll('\\', '/')}`;
  } else {
    throw new Error(`Unable to convert Windows path for rsync: ${localPath}`);
  }

  if (preserveTrailingSeparator && !rsyncPath.endsWith('/')) {
    rsyncPath += '/';
  }

  return rsyncPath;
}
