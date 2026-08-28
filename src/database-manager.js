/**
 * Database Manager for MCP SSH Manager
 * Provides database operations for MySQL, PostgreSQL, and MongoDB
 */

// Supported database types
export const DB_TYPES = {
  MYSQL: 'mysql',
  POSTGRESQL: 'postgresql',
  MONGODB: 'mongodb'
};

// A single quote character as a constant, so shellQuote()'s escaping stays
// readable under the repo's single-quote lint style.
import { shellQuote } from './shell-quote.js';
export { shellQuote };

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
    compress = true,
    tables = null
  } = options;

  let command = 'mysqldump';

  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${shellQuote(port)}`;

  command += ' --single-transaction --routines --triggers';
  command += ` ${shellQuote(database)}`;

  if (tables && Array.isArray(tables)) {
    command += ` ${tables.map(shellQuote).join(' ')}`;
  }

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
    compress = true,
    tables = null
  } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'pg_dump';
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${shellQuote(port)}`;
  command += ' --format=custom --clean --if-exists';

  if (tables && Array.isArray(tables)) {
    for (const table of tables) {
      command += ` -t ${shellQuote(table)}`;
    }
  }

  command += ` ${shellQuote(database)}`;

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
    compress = true,
    collections = null
  } = options;

  let command = 'mongodump';
  if (host) command += ` --host ${shellQuote(host)}`;
  if (port) command += ` --port ${shellQuote(port)}`;
  if (user) command += ` --username ${shellQuote(user)}`;
  if (password) command += ` --password ${shellQuote(password)}`;
  if (database) command += ` --db ${shellQuote(database)}`;

  if (collections && Array.isArray(collections)) {
    for (const collection of collections) {
      command += ` --collection ${shellQuote(collection)}`;
    }
  }

  command += ` --out ${shellQuote(outputDir)}`;

  if (compress) {
    command += ` && tar -czf ${shellQuote(outputDir + '.tar.gz')} -C "$(dirname ${shellQuote(outputDir)})" "$(basename ${shellQuote(outputDir)})"`;
    command += ` && rm -rf ${shellQuote(outputDir)}`;
  }

  return command;
}

/**
 * Build MySQL import command
 */
export function buildMySQLImportCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 3306,
    inputFile
  } = options;

  let command = '';

  if (inputFile.endsWith('.gz')) {
    command = `gunzip -c ${shellQuote(inputFile)} | `;
  } else {
    command = `cat ${shellQuote(inputFile)} | `;
  }

  command += 'mysql';
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${shellQuote(port)}`;
  command += ` ${shellQuote(database)}`;

  return command;
}

/**
 * Build PostgreSQL import command
 */
export function buildPostgreSQLImportCommand(options) {
  const {
    database,
    user,
    password,
    host = 'localhost',
    port = 5432,
    inputFile
  } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'pg_restore';
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${shellQuote(port)}`;
  command += ' --clean --if-exists';
  command += ` -d ${shellQuote(database)}`;

  if (inputFile.endsWith('.gz')) {
    command = `gunzip -c ${shellQuote(inputFile)} | ${command}`;
  } else {
    command += ` ${shellQuote(inputFile)}`;
  }

  return command;
}

/**
 * Build MongoDB restore command
 */
export function buildMongoDBRestoreCommand(options) {
  const {
    user,
    password,
    host = 'localhost',
    port = 27017,
    inputPath,
    drop = true
  } = options;

  let command = '';

  if (inputPath.endsWith('.tar.gz')) {
    const extractDir = inputPath.replace('.tar.gz', '');
    command = `tar -xzf ${shellQuote(inputPath)} -C "$(dirname ${shellQuote(inputPath)})" && `;
    command += 'mongorestore';
    if (drop) command += ' --drop';
    if (host) command += ` --host ${shellQuote(host)}`;
    if (port) command += ` --port ${shellQuote(port)}`;
    if (user) command += ` --username ${shellQuote(user)}`;
    if (password) command += ` --password ${shellQuote(password)}`;
    command += ` ${shellQuote(extractDir)}`;
    command += ` && rm -rf ${shellQuote(extractDir)}`;
  } else {
    command = 'mongorestore';
    if (drop) command += ' --drop';
    if (host) command += ` --host ${shellQuote(host)}`;
    if (port) command += ` --port ${shellQuote(port)}`;
    if (user) command += ` --username ${shellQuote(user)}`;
    if (password) command += ` --password ${shellQuote(password)}`;
    command += ` ${shellQuote(inputPath)}`;
  }

  return command;
}

/**
 * Build MySQL list databases command
 */
export function buildMySQLListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 3306 } = options;

  let command = 'mysql';
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${shellQuote(port)}`;
  command += ' -e "SHOW DATABASES;" | tail -n +2';

  return command;
}

/**
 * Build MySQL list tables command
 */
export function buildMySQLListTablesCommand(options) {
  const { database, user, password, host = 'localhost', port = 3306 } = options;

  let command = 'mysql';
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${shellQuote(port)}`;
  // Pass the database as a shell-quoted positional argument instead of
  // interpolating it into the -e SQL, so the name can inject neither the
  // shell nor the SQL (a crafted USE clause).
  command += ` ${shellQuote(database)} -e "SHOW TABLES;" | tail -n +2`;

  return command;
}

/**
 * Build PostgreSQL list databases command
 */
export function buildPostgreSQLListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 5432 } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'psql';
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${shellQuote(port)}`;
  command += ' -t -c "SELECT datname FROM pg_database WHERE datistemplate = false;" | sed \'/^$/d\' | sed \'s/^[ \\t]*//\'';

  return command;
}

/**
 * Build PostgreSQL list tables command
 */
export function buildPostgreSQLListTablesCommand(options) {
  const { database, user, password, host = 'localhost', port = 5432 } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'psql';
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${shellQuote(port)}`;
  command += ` -d ${shellQuote(database)}`;
  command += ' -t -c "SELECT tablename FROM pg_tables WHERE schemaname = \'public\';" | sed \'/^$/d\' | sed \'s/^[ \\t]*//\'';

  return command;
}

/**
 * Build MongoDB list databases command
 */
export function buildMongoDBListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${shellQuote(host)}`;
  if (port) command += ` --port ${shellQuote(port)}`;
  if (user) command += ` --username ${shellQuote(user)}`;
  if (password) command += ` --password ${shellQuote(password)}`;
  command += ' --quiet --eval "db.adminCommand(\'listDatabases\').databases.forEach(function(d){print(d.name)})"';

  return command;
}

/**
 * Build MongoDB list collections command
 */
export function buildMongoDBListCollectionsCommand(options) {
  const { database, user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${shellQuote(host)}`;
  if (port) command += ` --port ${shellQuote(port)}`;
  if (user) command += ` --username ${shellQuote(user)}`;
  if (password) command += ` --password ${shellQuote(password)}`;
  command += ` ${shellQuote(database)}`;
  command += ' --quiet --eval "db.getCollectionNames().forEach(function(c){print(c)})"';

  return command;
}

/**
 * Build a single-quoted shell heredoc that carries `body` to a command's stdin.
 *
 * The delimiter is single-quoted (`<<'DELIM'`) so the remote shell takes the body
 * literally — backticks, `$VAR`, and `$(...)` inside `body` are never expanded by the
 * shell. This is how SQL/JS query text is delivered to mysql/psql/mongo without the
 * shell parsing it first (the cause of issue #44: corruption of backtick-quoted
 * identifiers and remote command injection).
 *
 * When the command pipes its stdout onward (e.g. `mysql ... | awk ...`), the pipe must
 * stay on the heredoc's opening line — the terminator has to be alone on its own line —
 * so the pipeline is passed via `options.pipeline` and emitted as `<<'DELIM' | awk ...`.
 *
 * @param body Text fed to the command's stdin (e.g. a SQL statement). Passed verbatim.
 * @param {object} [options]
 * @param {string} [options.delimiter] Heredoc terminator. Must not appear as a standalone
 *   line in `body`, otherwise the heredoc would end early; this is rejected defensively.
 * @param {string} [options.pipeline] Shell pipeline appended after the heredoc marker on
 *   the opening line (e.g. `"| awk '...'"`). Omit for a plain stdin redirect.
 * @returns The redirection fragment to append after a command, ending with the
 *   terminator on its own line.
 * @throws {Error} If a line of `body` equals `delimiter`.
 * @example
 *   `mysql app${buildHeredoc('SELECT 1')}`
 *   // mysql app <<'__MCP_SQL_EOF__'\nSELECT 1\n__MCP_SQL_EOF__
 * @see buildMySQLQueryCommand
 */
export function buildHeredoc(body, { delimiter = '__MCP_SQL_EOF__', pipeline = '' } = {}) {
  const text = body == null ? '' : String(body);
  if (text.split('\n').some(line => line === delimiter)) {
    throw new Error(`Query contains the heredoc delimiter "${delimiter}" on its own line`);
  }
  const suffix = pipeline ? ` ${pipeline}` : '';
  return ` <<'${delimiter}'${suffix}\n${text}\n${delimiter}`;
}

/**
 * Build MySQL query command (SELECT only)
 */
export function buildMySQLQueryCommand(options) {
  const { database, query, user, password, host = 'localhost', port = 3306, format = 'json' } = options;

  // Validate query is SELECT only
  if (!isSafeQuery(query)) {
    throw new Error('Only SELECT queries are allowed');
  }

  let command = 'mysql';
  if (user) command += ` -u${shellQuote(user)}`;
  if (password) command += ` -p${shellQuote(password)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -P ${shellQuote(port)}`;
  command += ` ${shellQuote(database)}`;

  // Feed the SQL via stdin (quoted heredoc) so the remote shell never parses it —
  // backtick-quoted identifiers and `$` survive intact, and query text cannot inject
  // shell commands. See buildHeredoc and issue #44.
  if (format === 'json') {
    // Use JSON output if MySQL 5.7.8+. The awk pipe stays on the heredoc opening line so
    // the terminator remains alone on its own line.
    const awk = 'awk \'BEGIN{print "["} {if(NR>1)print ","; printf "{\\"row\\":%d,\\"data\\":\\"%s\\"}", NR, $0} END{print "]"}\'';
    command += ` --batch --skip-column-names${buildHeredoc(query, { pipeline: `| ${awk}` })}`;
  } else {
    command += buildHeredoc(query);
  }

  return command;
}

/**
 * Build PostgreSQL query command (SELECT only)
 */
export function buildPostgreSQLQueryCommand(options) {
  const { database, query, user, password, host = 'localhost', port = 5432 } = options;

  if (!isSafeQuery(query)) {
    throw new Error('Only SELECT queries are allowed');
  }

  let command = '';
  if (password) {
    command = `PGPASSWORD=${shellQuote(password)} `;
  }

  command += 'psql';
  if (user) command += ` -U ${shellQuote(user)}`;
  if (host) command += ` -h ${shellQuote(host)}`;
  if (port) command += ` -p ${shellQuote(port)}`;
  command += ` -d ${shellQuote(database)}`;
  // Feed SQL via stdin (quoted heredoc) instead of `-c "${query}"` so the remote shell
  // never parses it. See buildHeredoc and issue #44.
  command += buildHeredoc(query);

  return command;
}

/**
 * Build MongoDB query command
 */
export function buildMongoDBQueryCommand(options) {
  const { database, collection, query, user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${shellQuote(host)}`;
  if (port) command += ` --port ${shellQuote(port)}`;
  if (user) command += ` --username ${shellQuote(user)}`;
  if (password) command += ` --password ${shellQuote(password)}`;
  command += ` ${shellQuote(database)}`;
  // Feed the JS script via stdin (quoted heredoc) instead of `--eval "..."` so the
  // remote shell never expands backticks/`$` in the query. mongo still evaluates the
  // script as JavaScript (expected). See buildHeredoc and issue #44.
  const script = `db.${collection}.find(${query || '{}'}).forEach(printjson)`;
  command += ` --quiet${buildHeredoc(script)}`;

  return command;
}

/**
 * Validate query is safe (SELECT only)
 */
export function isSafeQuery(query) {
  const trimmedQuery = query.trim().toLowerCase();

  // Must start with SELECT
  if (!trimmedQuery.startsWith('select')) {
    return false;
  }

  // Block dangerous keywords
  const dangerousKeywords = [
    'insert', 'update', 'delete', 'drop', 'create', 'alter',
    'truncate', 'grant', 'revoke', 'exec', 'execute'
  ];

  for (const keyword of dangerousKeywords) {
    if (trimmedQuery.includes(keyword)) {
      return false;
    }
  }

  return true;
}

/**
 * Count the actual result rows in the raw output of an `ssh_db_query` command.
 *
 * The handler previously reported `output.split('\n').length`, which counts cosmetic
 * lines (the leading `[` of the MySQL JSON wrapper, psql headers/separators) rather than
 * data rows — so it was off by one for MySQL and over-counted for psql (issue #45). This
 * derives the count from the structure each engine actually produces.
 *
 * @param output Raw, already-trimmed stdout of the query command.
 * @param type One of {@link DB_TYPES} (`'mysql' | 'postgresql' | 'mongodb'`).
 * @param format Output format used to build the command; only `'json'` MySQL is wrapped
 *   by the `awk` JSON formatter, which is what this counts. Defaults to `'json'`.
 * @returns The number of result rows (documents for MongoDB). `0` for empty output.
 * @example
 *   countQueryRows('[\n{"row":1,"data":"a"},\n{"row":2,"data":"b"}]', 'mysql') // => 2
 *   countQueryRows(' id \n----\n  1\n(1 row)', 'postgresql')                   // => 1
 * @see buildMySQLQueryCommand
 */
export function countQueryRows(output, type, format = 'json') {
  if (!output || !output.trim()) {
    return 0;
  }
  const lines = output.split('\n');

  if (type === DB_TYPES.MYSQL) {
    if (format === 'json') {
      // The awk wrapper emits exactly one `{"row":N,...}` entry per result row, anchored
      // at the start of its own line, bracketed by cosmetic `[` / `]` lines.
      return lines.filter(line => /^\{"row":\d+,/.test(line)).length;
    }
    // Tabular `--batch` output: one row per non-empty line (column names are suppressed).
    return lines.filter(line => line.trim() !== '').length;
  }

  if (type === DB_TYPES.POSTGRESQL) {
    // psql prints an authoritative footer like `(13 rows)` — trust it when present.
    const footer = output.match(/\((\d+)\s+rows?\)/);
    if (footer) {
      return Number(footer[1]);
    }
    // Otherwise fall back to the data lines, dropping the column-header line, the
    // `---+---` separator, and any `(N rows)` footer line.
    const dataLines = lines.filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !/^[-+\s]+$/.test(trimmed) && !/^\(\d+\s+rows?\)$/.test(trimmed);
    });
    return Math.max(0, dataLines.length - 1); // first remaining line is the header
  }

  if (type === DB_TYPES.MONGODB) {
    // `printjson` closes each document with a `}` at column 0 — one per document.
    return lines.filter(line => line === '}').length;
  }

  // Unknown type: best-effort non-empty line count.
  return lines.filter(line => line.trim() !== '').length;
}

/**
 * Parse database list output
 */
export function parseDatabaseList(output, type) {
  const lines = output.trim().split('\n').filter(l => l.trim());

  // Filter out system databases
  return lines.filter(db => {
    const dbLower = db.toLowerCase();
    if (type === DB_TYPES.MYSQL) {
      return !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(dbLower);
    } else if (type === DB_TYPES.POSTGRESQL) {
      return !['template0', 'template1', 'postgres'].includes(dbLower);
    } else if (type === DB_TYPES.MONGODB) {
      return !['admin', 'config', 'local'].includes(dbLower);
    }
    return true;
  });
}

/**
 * Parse table/collection list output
 */
export function parseTableList(output) {
  return output.trim().split('\n').filter(l => l.trim());
}

/**
 * Parse size output to bytes
 */
export function parseSize(output) {
  const size = parseInt(output.trim());
  return isNaN(size) ? 0 : size;
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
