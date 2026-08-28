/**
 * Backup Manager for MCP SSH Manager
 * Handles creation, listing, restoration, and scheduling of backups
 * Supports databases (MySQL, PostgreSQL, MongoDB) and file backups
 */

import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { shellQuote, safeInteger } from './shell-quote.js';

// Backup types
export const BACKUP_TYPES = {
  MYSQL: 'mysql',
  POSTGRESQL: 'postgresql',
  MONGODB: 'mongodb',
  FILES: 'files',
  FULL: 'full'
};

// Default backup directory
export const DEFAULT_BACKUP_DIR = '/var/backups/ssh-manager';

/**
 * Generate unique backup ID
 */
export function generateBackupId(type, name) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(4).toString('hex');
  return `${type}_${name}_${timestamp}_${random}`;
}

/**
 * Get backup metadata file path
 */
export function getBackupMetadataPath(backupId, backupDir = DEFAULT_BACKUP_DIR) {
  return path.join(backupDir, `${backupId}.meta.json`);
}

/**
 * Get backup file path
 */
export function getBackupFilePath(backupId, backupDir = DEFAULT_BACKUP_DIR, extension = '.gz') {
  return path.join(backupDir, `${backupId}${extension}`);
}

/**
 * Build MySQL dump command
 */
export function buildMySQLDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 3306,
    outputFile,
    singleTransaction = true,
    compress = true
  } = options;

  let command = 'mysqldump';

  // Connection parameters
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${safeInteger(port, 3306)}`;

  // Dump options
  if (singleTransaction) command += ' --single-transaction';
  command += ' --routines --triggers';

  // Database name
  command += ` ${shellQuote(database)}`;

  // Output handling
  if (compress) {
    command += ` | gzip > ${shellQuote(outputFile)}`;
  } else {
    command += ` > ${shellQuote(outputFile)}`;
  }

  return command;
}

/**
 * Build PostgreSQL dump command
 */
export function buildPostgreSQLDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 5432,
    outputFile,
    compress = true
  } = options;

  // PostgreSQL uses PGPASSWORD environment variable
  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'pg_dump';

  // Connection parameters
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${safeInteger(port, 5432)}`;

  // Dump options
  command += ' --format=custom --clean --if-exists';

  // Database name
  command += ` ${shellQuote(database)}`;

  // Output handling
  if (compress) {
    command += ` | gzip > ${shellQuote(outputFile)}`;
  } else {
    command += ` > ${shellQuote(outputFile)}`;
  }

  return command;
}

/**
 * Build MongoDB dump command
 */
export function buildMongoDBDumpCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 27017,
    outputDir,
    compress = true
  } = options;

  let command = 'mongodump';

  // Connection parameters
  if (host) command += ` --host ${shellQuote(host)}`;
  if (port) command += ` --port ${safeInteger(port, 27017)}`;
  if (user) command += ` --username ${shellQuote(user)}`;
  if (password) command += ` --password ${shellQuote(password)}`;

  // Database selection
  if (database) command += ` --db ${shellQuote(database)}`;

  // Output directory
  command += ` --out ${shellQuote(outputDir)}`;

  // Compress the output directory
  if (compress) {
    const archiveName = `${outputDir}.tar.gz`;
    // dirname/basename receive the quoted value, so the substitution itself
    // cannot be steered by the caller.
    command += ` && tar -czf ${shellQuote(archiveName)} -C "$(dirname ${shellQuote(outputDir)})" "$(basename ${shellQuote(outputDir)})"`;
    command += ` && rm -rf ${shellQuote(outputDir)}`;
  }

  return command;
}

/**
 * Build files backup command (tar + gzip)
 */
export function buildFilesBackupCommand(options) {
  const {
    paths,
    outputFile,
    exclude = [],
    compress = true
  } = options;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array');
  }

  let command = 'tar';

  // Compression flag
  if (compress) {
    command += ' -czf';
  } else {
    command += ' -cf';
  }

  // Output file
  command += ` ${shellQuote(outputFile)}`;

  // Exclude patterns
  for (const pattern of exclude) {
    command += ` --exclude=${shellQuote(pattern)}`;
  }

  // Paths to backup
  command += ` ${paths.map(p => shellQuote(p)).join(' ')}`;

  return command;
}

/**
 * Build backup restore command based on type
 */
export function buildRestoreCommand(backupType, backupFile, options = {}) {
  switch (backupType) {
  case BACKUP_TYPES.MYSQL:
    return buildMySQLRestoreCommand(backupFile, options);
  case BACKUP_TYPES.POSTGRESQL:
    return buildPostgreSQLRestoreCommand(backupFile, options);
  case BACKUP_TYPES.MONGODB:
    return buildMongoDBRestoreCommand(backupFile, options);
  case BACKUP_TYPES.FILES:
    return buildFilesRestoreCommand(backupFile, options);
  default:
    throw new Error(`Unknown backup type: ${backupType}`);
  }
}

/**
 * Build MySQL restore command
 */
function buildMySQLRestoreCommand(backupFile, options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 3306
  } = options;

  let command = '';

  // Decompress if needed
  if (backupFile.endsWith('.gz')) {
    command = `gunzip -c ${shellQuote(backupFile)} | `;
  } else {
    command = `cat ${shellQuote(backupFile)} | `;
  }

  command += 'mysql';

  // Connection parameters
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${safeInteger(port, 3306)}`;
  if (database) command += ` ${shellQuote(database)}`;

  return command;
}

/**
 * Build PostgreSQL restore command
 */
function buildPostgreSQLRestoreCommand(backupFile, options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 5432
  } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'pg_restore';

  // Connection parameters
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${safeInteger(port, 5432)}`;
  if (database) command += ` -d ${shellQuote(database)}`;

  // Restore options
  command += ' --clean --if-exists';

  // Handle compressed files
  if (backupFile.endsWith('.gz')) {
    command = `gunzip -c ${shellQuote(backupFile)} | ${command}`;
  } else {
    command += ` ${shellQuote(backupFile)}`;
  }

  return command;
}

/**
 * Build MongoDB restore command
 */
function buildMongoDBRestoreCommand(backupFile, options) {
  const {
    user,
    password,
    host = 'localhost',
    port = 27017,
    drop = true
  } = options;

  let command = '';

  // Extract if compressed
  if (backupFile.endsWith('.tar.gz')) {
    const extractDir = backupFile.replace('.tar.gz', '');
    command = `tar -xzf ${shellQuote(backupFile)} -C "$(dirname ${shellQuote(backupFile)})" && `;
    command += 'mongorestore';

    if (drop) command += ' --drop';
    if (host) command += ` --host ${shellQuote(host)}`;
    if (port) command += ` --port ${safeInteger(port, 27017)}`;
    if (user) command += ` --username ${shellQuote(user)}`;
    if (password) command += ` --password ${shellQuote(password)}`;

    command += ` ${shellQuote(extractDir)}`;
    command += ` && rm -rf ${shellQuote(extractDir)}`;
  } else {
    command = 'mongorestore';
    if (drop) command += ' --drop';
    if (host) command += ` --host ${shellQuote(host)}`;
    if (port) command += ` --port ${safeInteger(port, 27017)}`;
    if (user) command += ` --username ${shellQuote(user)}`;
    if (password) command += ` --password ${shellQuote(password)}`;
    command += ` ${shellQuote(backupFile)}`;
  }

  return command;
}

/**
 * Build files restore command
 */
function buildFilesRestoreCommand(backupFile, options) {
  const { targetPath = '/' } = options;

  let command = 'tar';

  // Auto-detect compression
  if (backupFile.endsWith('.gz') || backupFile.endsWith('.tgz')) {
    command += ' -xzf';
  } else {
    command += ' -xf';
  }

  command += ` ${shellQuote(backupFile)}`;
  command += ` -C ${shellQuote(targetPath)}`;

  return command;
}

/**
 * Create backup metadata object
 */
export function createBackupMetadata(backupId, type, options = {}) {
  return {
    id: backupId,
    type,
    created_at: new Date().toISOString(),
    server: options.server || 'unknown',
    database: options.database || null,
    paths: options.paths || [],
    size: null, // Will be filled after backup
    compressed: options.compress !== false,
    retention: options.retention || 7, // days
    status: 'pending',
    error: null
  };
}

/**
 * Build command to save metadata to remote server
 */
export function buildSaveMetadataCommand(metadata, metadataPath) {
  const jsonData = JSON.stringify(metadata, null, 2);
  // The metadata carries caller-supplied fields (database name, paths...), so
  // both the payload and the destination go through shellQuote rather than
  // hand-rolled escaping.
  return `echo ${shellQuote(jsonData)} > ${shellQuote(metadataPath)}`;
}

/**
 * Build command to list backups from remote server
 */
export function buildListBackupsCommand(backupDir = DEFAULT_BACKUP_DIR, type = null) {
  let command = `find ${shellQuote(backupDir)} -name '*.meta.json' -type f`;

  if (type) {
    command += ` | grep ${shellQuote(`${type}_`)}`;
  }

  // Read and parse each metadata file
  command += ' | while read -r file; do cat "$file"; echo "---"; done';

  return command;
}

/**
 * Parse list backups output
 */
export function parseBackupsList(output) {
  if (!output || !output.trim()) {
    return [];
  }

  const backups = [];
  const metadataBlocks = output.split('---').filter(b => b.trim());

  for (const block of metadataBlocks) {
    try {
      const metadata = JSON.parse(block.trim());
      backups.push(metadata);
    } catch (error) {
      logger.warn('Failed to parse backup metadata', { error: error.message, block });
    }
  }

  // Sort by created_at descending
  return backups.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/**
 * Build cleanup old backups command (based on retention)
 */
export function buildCleanupCommand(backupDir = DEFAULT_BACKUP_DIR, retentionDays = 7) {
  // Find backup files older than retention period and delete them
  return `find ${shellQuote(backupDir)} -name '*_*_*' -type f -mtime +${safeInteger(retentionDays, 7)} -delete`;
}

/**
 * Build cron schedule command
 */
export function buildCronScheduleCommand(schedule, backupCommand, cronComment) {
  // A crontab line is data here, not a command to evaluate: the whole line goes
  // through shellQuote so a schedule or comment carrying quotes cannot break
  // out of the echo and run something else. backupCommand is built by the
  // builders above, which quote their own arguments.
  const cronLine = `${schedule} ${backupCommand} # ${cronComment}`;
  return `(crontab -l 2>/dev/null; echo ${shellQuote(cronLine)}) | crontab -`;
}
