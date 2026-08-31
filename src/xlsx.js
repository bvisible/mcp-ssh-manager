/**
 * Reading and writing one-sheet spreadsheets, without a dependency.
 *
 * ## Why not a library
 *
 * People asked to fill in a spreadsheet, which is a reasonable thing to want and
 * the reason CSV keeps losing: a CSV opened in Excel mangles a leading zero in a
 * port, guesses at the separator by locale, and offers no column headers you can
 * rely on. A real `.xlsx` avoids all three.
 *
 * The obvious way to read one is SheetJS, which is seven megabytes. This package
 * is 730 KB and installs on machines whose whole job is to sit behind SSH; a
 * tenfold increase for one import path is not a trade worth making.
 *
 * An `.xlsx` is a ZIP of XML files. Node ships `zlib`, which is the hard half.
 * The rest is a few hundred lines of container format, written here, tested
 * against files Excel and LibreOffice actually produce.
 *
 * ## What this handles, and what it does not
 *
 * One sheet, a header row, and cells that are text or numbers — which is exactly
 * what a server list is. Not: formulas, dates, styles, merged cells, multiple
 * sheets. A file using any of those still reads; the extra is ignored.
 */
import zlib from 'zlib';

/* ------------------------------------------------------------------ the ZIP */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} CRC-32, as the ZIP format wants it */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP archive from named buffers.
 *
 * Everything is deflated and stored without directory entries — a `.xlsx` is
 * read by name, so the tree structure is implied by the paths.
 *
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const sum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(0, 10);            // time — fixed, so output is reproducible
    local.writeUInt16LE(0x21, 12);         // date — 1980-01-01
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, deflated);

    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(0, 42);              // external attributes
    dir.writeUInt32LE(offset, 42);
    name.copy(dir, 46);
    central.push(dir);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/**
 * Read a ZIP archive into a map of name → contents.
 *
 * Walks the central directory rather than scanning for local headers: the
 * directory is authoritative, and a file whose entries were rewritten in place
 * (which Excel does) can carry stale local headers.
 *
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>}
 */
function unzip(buf) {
  // The end-of-central-directory record is last, but a trailing comment can push
  // it back up to 64 KB from the end, so scan backwards for its signature.
  let end = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  /** @type {Map<string, Buffer>} */
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);

    // The local header's own name and extra lengths are what locate the data;
    // they are allowed to differ from the central directory's.
    const localNameLength = buf.readUInt16LE(localAt + 26);
    const localExtraLength = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataAt, dataAt + compressed);

    if (!name.endsWith('/')) {
      files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/* ------------------------------------------------------------------ the XML */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' };
const escape = value => String(value).replace(/[&<>"']/g, c => ESCAPES[c]);

const UNESCAPES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
const unescape = text => text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
  (_, entity) => {
    if (entity[0] !== '#') return UNESCAPES[entity];
    return String.fromCodePoint(entity[1] === 'x'
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10));
  });

/** A1 → column 0, B1 → 1, AA1 → 26. Cells can be sparse, so this is how gaps are found. */
function columnOf(reference) {
  let n = 0;
  for (const ch of reference) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

/* --------------------------------------------------------------------- read */

/**
 * Read the first worksheet as rows of strings.
 *
 * @param {Buffer} buf - The .xlsx file
 * @returns {string[][]} Rows, each padded to the widest row seen
 */
export function readSheet(buf) {
  const files = unzip(buf);

  // Excel puts every string in one table and refers to it by index; LibreOffice
  // sometimes writes them inline. Both shapes appear in the wild.
  /** @type {string[]} */
  const shared = [];
  const sharedXml = files.get('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const item of sharedXml.toString('utf8').split(/<si[\s>]/).slice(1)) {
      // A string can be split across runs; concatenate every <t> in the item.
      const parts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescape(m[1]));
      shared.push(parts.join(''));
    }
  }

  const sheetName = [...files.keys()].find(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new Error('No worksheet in this file');
  const sheet = files.get(sheetName).toString('utf8');

  /** @type {string[][]} */
  const rows = [];
  let width = 0;

  for (const rowXml of sheet.split(/<row[\s>]/).slice(1)) {
    /** @type {string[]} */
    const row = [];
    for (const cell of rowXml.matchAll(/<c\s([^>]*?)\/?>([\s\S]*?)(?:<\/c>|$)/g)) {
      const attributes = cell[1];
      const body = cell[2];
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const index = reference ? columnOf(reference) : row.length;
      const type = /t="([^"]+)"/.exec(attributes)?.[1];

      let value = '';
      if (type === 's') {
        const at = Number(/<v>(\d+)<\/v>/.exec(body)?.[1]);
        value = shared[at] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescape(m[1])).join('');
      } else {
        value = unescape(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }

      while (row.length < index) row.push('');
      row[index] = value.trim();
    }
    width = Math.max(width, row.length);
    rows.push(row);
  }

  for (const row of rows) while (row.length < width) row.push('');
  return rows;
}

/* -------------------------------------------------------------------- write */

/**
 * Write one sheet as a .xlsx.
 *
 * Everything is an inline string, which sidesteps the shared-string table
 * entirely. The file is a little larger and a great deal easier to be sure
 * about; a server list is tens of rows, not tens of thousands.
 *
 * @param {string[][]} rows - First row is treated as the header
 * @param {{sheetName?: string, widths?: number[]}} [options]
 * @returns {Buffer}
 */
export function writeSheet(rows, options = {}) {
  const sheetName = options.sheetName || 'Servers';
  const columns = (options.widths || []).map(
    (width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('');

  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const reference = `${String.fromCharCode(65 + (c % 26))}${r + 1}`;
      if (value === '' || value === null || value === undefined) return '';
      // The header row is bold, via the one style defined below.
      const style = r === 0 ? ' s="1"' : '';
      return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');

  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'],
    ['xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>'],
    // Two fonts and two formats: the second of each is the bold header.
    ['xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf/></cellStyleXfs>'
      + '<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>'
      + '</styleSheet>'],
    ['xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (columns ? `<cols>${columns}</cols>` : '')
      + `<sheetData>${body}</sheetData></worksheet>`],
  ];

  return zip(files.map(([name, xml]) => ({ name, data: Buffer.from(xml, 'utf8') })));
}
