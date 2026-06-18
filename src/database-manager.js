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

  if (user) command += ` -u${user}`;
  if (password) command += ` -p'${password}'`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -P ${port}`;

  command += ' --single-transaction --routines --triggers';
  command += ` ${database}`;

  if (tables && Array.isArray(tables)) {
    command += ` ${tables.join(' ')}`;
  }

  if (compress) {
    command += ` | gzip > "${outputFile}"`;
  } else {
    command += ` > "${outputFile}"`;
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
    command = `PGPASSWORD='${password}' `;
  }

  command += 'pg_dump';
  if (user) command += ` -U ${user}`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -p ${port}`;
  command += ' --format=custom --clean --if-exists';

  if (tables && Array.isArray(tables)) {
    for (const table of tables) {
      command += ` -t ${table}`;
    }
  }

  command += ` ${database}`;

  if (compress) {
    command += ` | gzip > "${outputFile}"`;
  } else {
    command += ` > "${outputFile}"`;
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
  if (host) command += ` --host ${host}`;
  if (port) command += ` --port ${port}`;
  if (user) command += ` --username ${user}`;
  if (password) command += ` --password '${password}'`;
  if (database) command += ` --db ${database}`;

  if (collections && Array.isArray(collections)) {
    for (const collection of collections) {
      command += ` --collection ${collection}`;
    }
  }

  command += ` --out "${outputDir}"`;

  if (compress) {
    command += ` && tar -czf "${outputDir}.tar.gz" -C "$(dirname ${outputDir})" "$(basename ${outputDir})"`;
    command += ` && rm -rf "${outputDir}"`;
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
    command = `gunzip -c "${inputFile}" | `;
  } else {
    command = `cat "${inputFile}" | `;
  }

  command += 'mysql';
  if (user) command += ` -u${user}`;
  if (password) command += ` -p'${password}'`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -P ${port}`;
  command += ` ${database}`;

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
    command = `PGPASSWORD='${password}' `;
  }

  command += 'pg_restore';
  if (user) command += ` -U ${user}`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -p ${port}`;
  command += ' --clean --if-exists';
  command += ` -d ${database}`;

  if (inputFile.endsWith('.gz')) {
    command = `gunzip -c "${inputFile}" | ${command}`;
  } else {
    command += ` "${inputFile}"`;
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
    command = `tar -xzf "${inputPath}" -C "$(dirname ${inputPath})" && `;
    command += 'mongorestore';
    if (drop) command += ' --drop';
    if (host) command += ` --host ${host}`;
    if (port) command += ` --port ${port}`;
    if (user) command += ` --username ${user}`;
    if (password) command += ` --password '${password}'`;
    command += ` "${extractDir}"`;
    command += ` && rm -rf "${extractDir}"`;
  } else {
    command = 'mongorestore';
    if (drop) command += ' --drop';
    if (host) command += ` --host ${host}`;
    if (port) command += ` --port ${port}`;
    if (user) command += ` --username ${user}`;
    if (password) command += ` --password '${password}'`;
    command += ` "${inputPath}"`;
  }

  return command;
}

/**
 * Build MySQL list databases command
 */
export function buildMySQLListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 3306 } = options;

  let command = 'mysql';
  if (user) command += ` -u${user}`;
  if (password) command += ` -p'${password}'`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -P ${port}`;
  command += ' -e "SHOW DATABASES;" | tail -n +2';

  return command;
}

/**
 * Build MySQL list tables command
 */
export function buildMySQLListTablesCommand(options) {
  const { database, user, password, host = 'localhost', port = 3306 } = options;

  let command = 'mysql';
  if (user) command += ` -u${user}`;
  if (password) command += ` -p'${password}'`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -P ${port}`;
  command += ` -e "USE ${database}; SHOW TABLES;" | tail -n +2`;

  return command;
}

/**
 * Build PostgreSQL list databases command
 */
export function buildPostgreSQLListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 5432 } = options;

  let command = '';
  if (password) {
    command = `PGPASSWORD='${password}' `;
  }

  command += 'psql';
  if (user) command += ` -U ${user}`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -p ${port}`;
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
    command = `PGPASSWORD='${password}' `;
  }

  command += 'psql';
  if (user) command += ` -U ${user}`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -p ${port}`;
  command += ` -d ${database}`;
  command += ' -t -c "SELECT tablename FROM pg_tables WHERE schemaname = \'public\';" | sed \'/^$/d\' | sed \'s/^[ \\t]*//\'';

  return command;
}

/**
 * Build MongoDB list databases command
 */
export function buildMongoDBListDatabasesCommand(options) {
  const { user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${host}`;
  if (port) command += ` --port ${port}`;
  if (user) command += ` --username ${user}`;
  if (password) command += ` --password '${password}'`;
  command += ' --quiet --eval "db.adminCommand(\'listDatabases\').databases.forEach(function(d){print(d.name)})"';

  return command;
}

/**
 * Build MongoDB list collections command
 */
export function buildMongoDBListCollectionsCommand(options) {
  const { database, user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${host}`;
  if (port) command += ` --port ${port}`;
  if (user) command += ` --username ${user}`;
  if (password) command += ` --password '${password}'`;
  command += ` ${database}`;
  command += ' --quiet --eval "db.getCollectionNames().forEach(function(c){print(c)})"';

  return command;
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
  if (user) command += ` -u${user}`;
  if (password) command += ` -p'${password}'`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -P ${port}`;
  command += ` ${database}`;

  if (format === 'json') {
    // Use JSON output if MySQL 5.7.8+
    command += ` -e "${query}" --batch --skip-column-names | awk 'BEGIN{print "["} {if(NR>1)print ","; printf "{\\"row\\":%d,\\"data\\":\\"%s\\"}", NR, $0} END{print "]"}'`;
  } else {
    command += ` -e "${query}"`;
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
    command = `PGPASSWORD='${password}' `;
  }

  command += 'psql';
  if (user) command += ` -U ${user}`;
  if (host) command += ` -h ${host}`;
  if (port) command += ` -p ${port}`;
  command += ` -d ${database}`;
  command += ` -c "${query}"`;

  return command;
}

/**
 * Build MongoDB query command
 */
export function buildMongoDBQueryCommand(options) {
  const { database, collection, query, user, password, host = 'localhost', port = 27017 } = options;

  let command = 'mongo';
  if (host) command += ` --host ${host}`;
  if (port) command += ` --port ${port}`;
  if (user) command += ` --username ${user}`;
  if (password) command += ` --password '${password}'`;
  command += ` ${database}`;
  command += ` --quiet --eval "db.${collection}.find(${query || '{}'}).forEach(printjson)"`;

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
