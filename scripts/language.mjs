#!/usr/bin/env node
// Languages of the interface and of the desktop application.
//
//   npm run lang -- add <code> [--name "Français"] [--label "Langue"]
//       Creates the three catalogues of a new language from the English text and,
//       when the Windows installer has a page for it, lists that page too.
//   npm run lang -- status
//       Shows, per language, how many entries are still the English text.
//
// A language is three files, and nothing else names it: the interface and the desktop
// application find them by their names (ui/README.md, "Adding a language").
//   ui/src/locales/<code>.json            labels of the carried-over components, plus language.name / language.label
//   ui/src/locales/messages.<code>.json   the interface's sentences (keys are the English sentences)
//   desktop/electron/native.<code>.json   menus, tray and notifications of the desktop application
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The page of the Windows installer for a language, by the code the installer's
 * builder uses. A language that is not here still gets its catalogues; it only has no
 * page of its own in the installer, which then shows its own languages' pages.
 */
const INSTALLER_LOCALES = {
  cs: 'cs_CZ', da: 'da_DK', de: 'de_DE', el: 'el_GR', es: 'es_ES', fi: 'fi_FI',fr: 'fr_FR', hu: 'hu_HU',
  it: 'it_IT', ja: 'ja_JP', ko: 'ko_KR', nb: 'nb_NO', nl: 'nl_NL', pl: 'pl_PL', 'pt-BR': 'pt_BR', pt: 'pt_PT',
  ro: 'ro_RO', ru: 'ru_RU', sv: 'sv_SE', tr: 'tr_TR', uk: 'uk_UA', vi: 'vi_VN', 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW',
};

/** The installer page code for a language code, or undefined when none is known. */
export function installerLocaleFor(code) {
  return INSTALLER_LOCALES[code] ?? INSTALLER_LOCALES[code.split('-')[0]];
}

/** Language, optional script, optional region: `fr`, `pt-BR`, `zh-Hant-TW`, `es-419`. */
const CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

const files = root => ({
  locales: path.join(root, 'ui', 'src', 'locales'),
  electron: path.join(root, 'desktop', 'electron'),
  builder: path.join(root, 'desktop', 'electron', 'electron-builder.yml'),
});

/** Codes found in a folder from file names like `<prefix><code>.json`. */
function discover(folder, prefix) {
  const pattern = new RegExp(`^${prefix}([A-Za-z0-9-]+)\\.json$`);
  return fs.readdirSync(folder).map(name => pattern.exec(name)?.[1]).filter(Boolean).sort();
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
/** `flag: 'wx'` creates the file and fails if it exists, in one step. */
const writeJson = (file, data, flag = 'w') => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag });
/** The file's text, or undefined when it is not there: one read, so nothing can change between a check and the use. */
function readIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const flatten = (object, prefix = '') => Object.entries(object)
  .flatMap(([key, value]) => (value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]));

/** The language written in itself ("fr" → "Français"), or the code when the platform has no name for it. */
function ownName(code) {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name && name !== code ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : code;
  } catch { return code; }
}

/**
 * Create the three catalogues of a new language, every value being the English text to
 * translate. Returns what was written. Refuses a bad code, English, and a language that exists.
 */
export function addLanguage(root, code, { name, label } = {}) {
  const where = files(root);
  if (code === 'en') throw new Error('English is the source language: it cannot be added');
  const same = discover(where.locales, '').find(known => known.toLowerCase() === code.toLowerCase());
  if (same) throw new Error(`the language ${same} already exists`);
  if (!CODE.test(code)) throw new Error(`"${code}" is not a language code like fr, pt-BR or zh-Hant-TW`);

  const english = readJson(path.join(where.locales, 'en.json'));
  const sentences = readJson(path.join(where.locales, 'messages.en.json'));
  const reference = discover(where.electron, 'native\\.')[0];
  if (!reference) throw new Error('no desktop catalogue to take the menu sentences from');
  const native = Object.fromEntries(Object.keys(readJson(path.join(where.electron, `native.${reference}.json`))).map(key => [key, key]));

  const written = [
    [path.join(where.locales, `${code}.json`), { ...english, language: { name: name || ownName(code), label: label || english.language?.label || 'Language' } }],
    [path.join(where.locales, `messages.${code}.json`), sentences],
    [path.join(where.electron, `native.${code}.json`), native],
  ];
  for (const [file, content] of written) writeJson(file, content, 'wx');

  const installer = installerLocaleFor(code);
  let installerAdded = false;
  const text = installer ? readIfPresent(where.builder) : undefined;
  if (text !== undefined) {
    const line = /^(\s*installerLanguages:\s*\[)([^\]]*)(\])/m.exec(text);
    if (line) {
      const pages = line[2].split(',').map(page => page.trim()).filter(Boolean);
      if (!pages.includes(installer)) {
        fs.writeFileSync(where.builder, text.replace(line[0], `${line[1]}${[...pages, installer].join(', ')}${line[3]}`));
        installerAdded = true;
      }
    }
  }
  return { files: written.map(([file]) => path.relative(root, file)), installer: installerAdded ? installer : undefined, installerKnown: Boolean(installer) };
}

/** Per language: entries (of each catalogue) that are still the English text. */
export function languageStatus(root) {
  const where = files(root);
  const english = Object.fromEntries(flatten(readJson(path.join(where.locales, 'en.json'))));
  const result = [];
  for (const code of discover(where.locales, '').filter(known => known !== 'en')) {
    const labels = readJson(path.join(where.locales, `${code}.json`));
    const labelEntries = flatten(labels).filter(([key]) => !key.startsWith('language.'));
    const sentences = Object.entries(readJson(path.join(where.locales, `messages.${code}.json`)));
    const nativeText = readIfPresent(path.join(where.electron, `native.${code}.json`));
    const menus = nativeText === undefined ? [] : Object.entries(JSON.parse(nativeText));
    result.push({
      code,
      name: labels.language?.name ?? code,
      labels: { same: labelEntries.filter(([key, value]) => value === english[key]).length, total: labelEntries.length },
      sentences: { same: sentences.filter(([key, value]) => value === key).length, total: sentences.length },
      menus: { same: menus.filter(([key, value]) => value === key).length, total: menus.length },
    });
  }
  return result;
}

function printStatus(rows) {
  const cell = ({ same, total }) => `${same} of ${total}`;
  const head = ['language', 'name', 'labels', 'sentences', 'desktop menus'];
  const lines = [head, ...rows.map(row => [row.code, row.name, cell(row.labels), cell(row.sentences), cell(row.menus)])];
  const widths = head.map((_, column) => Math.max(...lines.map(line => [...line[column]].length)));
  console.log('Entries still identical to the English text (a few are right to be: names, "OK"):');
  for (const line of lines) console.log(line.map((text, column) => text + ' '.repeat(widths[column] - [...text].length)).join('  ').trimEnd());
}

function main(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (['--name', '--label', '--root'].includes(argv[i])) options[argv[i].slice(2)] = argv[++i];
    else rest.push(argv[i]);
  }
  const root = options.root ? path.resolve(options.root) : repository;
  const [command, code] = rest;
  try {
    if (command === 'add' && code) {
      const done = addLanguage(root, code, options);
      console.log(`Added ${code}:`);
      for (const file of done.files) console.log(`  ${file}`);
      if (done.installer) console.log(`  desktop/electron/electron-builder.yml: installer page ${done.installer}`);
      else if (!done.installerKnown) console.log('  (no Windows installer page known for this language: the catalogues work without one)');
      console.log('\nEvery value starts as the English text. Translate the values; keep the keys of');
      console.log('messages.<code>.json and native.<code>.json as they are, and keep every {{placeholder}}.');
      console.log('Then: npm run test:locale, and npm run lang -- status.');
    } else if (command === 'status') {
      printStatus(languageStatus(root));
    } else {
      console.error('usage: npm run lang -- add <code> [--name "Français"] [--label "Langue"]\n       npm run lang -- status');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`lang: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
