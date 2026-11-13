// Backups and restores whose exit code means what it says.
//
// `mysqldump ... | gzip > out` reports the exit code of the LAST command of the
// pipeline: when the dump failed (wrong password, missing database, full disk),
// gzip still succeeded, the file was an empty archive of 20 bytes, and ssh_db_dump
// and ssh_backup_create answered success with it. The mirror image on the way in:
// `gunzip -c dump.gz | mysql` runs mysql on whatever gunzip managed to read, so a
// truncated archive was restored in part, without an error.
//
// Found by reading jaredshuai's fork, which hit the same two defects and fixed them
// with a temporary file; this keeps the dump streaming (a database can be bigger than
// the free space on its own disk) by recording the producer's exit status on the side.
//
// Both commands are one simple command of single-quoted words (sh -c '<script>' sh
// <args>), like withRemoteTimeout: the SSH server hands them to the account's login
// shell, which may be csh or tcsh and would reject `{ }` and `$?` at the top level.
// The producer and the file names are positional parameters, never spliced into the
// script, and the producer is the same quoted text that used to run as it was.
import { shellQuote } from './shell-quote.js';

// $1 = file to write, $2 = the producing command, $3 = 1 to compress.
// The producer's status goes to a file next to the output (no mktemp: it is not on
// every system, and the folder is known to be writable since the output goes there).
// A failed run leaves no output file at all, so nothing can be mistaken for a backup.
const GUARDED_DUMP_SCRIPT = [
  'out=$1; st="$1.status.$$"; trap \'rm -f "$st"\' EXIT;',
  'if [ "$3" = 1 ]; then',
  '{ eval "$2"; echo $? > "$st"; } | gzip -c > "$out"; gz=$?;',
  'read status < "$st" || status=1;',
  'if [ "$status" != 0 ] || [ "$gz" != 0 ]; then rm -f "$out"; exit 1; fi;',
  'else eval "$2" > "$out" || { rm -f "$out"; exit 1; }; fi',
].join(' ');

// $1 = the gzip file, $2 = the command that reads the decompressed stream.
// A real gzip file is tested whole before a byte reaches the consumer. A file that
// is not gzip at all (a plain dump a backup left under a .gz name when it was made
// without compression) is fed as it is, so it is not refused for its name.
const GUARDED_FEED_SCRIPT = [
  'f=$1;',
  'if [ "$(head -c 2 "$f" | od -An -tx1 | tr -d " \\n")" = 1f8b ];',
  'then gzip -t "$f" || exit 1; gunzip -c "$f" | eval "$2";',
  'else eval "$2" < "$f"; fi',
].join(' ');

/**
 * The command that runs `producer` and writes its output to `outputFile`
 * (gzipped when `compress`), and fails, leaving no file, if the producer does.
 * @param {string} producer - A command line already built from quoted words
 * @param {string} outputFile
 * @param {boolean} [compress]
 * @returns {string}
 */
export function guardedDump(producer, outputFile, compress = true) {
  return `sh -c ${shellQuote(GUARDED_DUMP_SCRIPT)} sh ${shellQuote(outputFile)} ${shellQuote(producer)} ${compress ? '1' : '0'}`;
}

/**
 * The command that feeds a gzip file to `consumer` once the whole file has been
 * verified, and fails without running the consumer if it is corrupt.
 * @param {string} gzipFile
 * @param {string} consumer - A command line already built from quoted words
 * @returns {string}
 */
export function guardedFeed(gzipFile, consumer) {
  return `sh -c ${shellQuote(GUARDED_FEED_SCRIPT)} sh ${shellQuote(gzipFile)} ${shellQuote(consumer)}`;
}

/**
 * Where mongodump's output ends up when it is compressed: one archive beside the
 * dump directory. The one place that knows it: the dump builders write it, and
 * ssh_backup_create, ssh_backup_restore and ssh_db_dump measure, record and read the
 * same path. They used to disagree (written as <id>.tar.gz, measured and restored as
 * <id>.gz), so a MongoDB backup reported a size of 0 and could not be restored.
 * @param {string} outputDir
 * @returns {string}
 */
export function mongoArchivePath(outputDir) {
  return `${outputDir}.tar.gz`;
}
