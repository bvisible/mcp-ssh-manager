import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { languageForLocale, nativeLanguage, nativeLanguages, nativeText } from '../desktop/electron/locale.mjs';
import { applicationMenuTemplate } from '../desktop/electron/native-menu.mjs';
import { installerLocaleFor } from '../scripts/language.mjs';

const read = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const codesIn = (folder, pattern) => fs.readdirSync(new URL('../' + folder + '/', import.meta.url)).map(name => pattern.exec(name)?.[1]).filter(Boolean).sort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-locale-'));
const choose = value => fs.writeFileSync(path.join(home, 'preferences.json'), typeof value === 'string' ? value : JSON.stringify(value));
// A code no language will ever have (ISO 639 keeps `qaa`-`qtz` for private use).
const NO_SUCH_LANGUAGE = 'qaa';
try {
  // A language is three files; the set of languages is whatever the folders hold, and the three agree.
  const labelCodes = codesIn('ui/src/locales', /^([A-Za-z0-9-]+)\.json$/);
  const sentenceCodes = codesIn('ui/src/locales', /^messages\.([A-Za-z0-9-]+)\.json$/);
  const nativeCodes = codesIn('desktop/electron', /^native\.([A-Za-z0-9-]+)\.json$/);
  assert.ok(labelCodes.includes('en') && nativeCodes.length >= 2, 'English and the shipped languages are found');
  assert.deepEqual(sentenceCodes, labelCodes, 'every language has both interface catalogues');
  assert.deepEqual(labelCodes, ['en', ...nativeCodes].sort(), 'the interface and the desktop application speak the same languages');
  assert.deepEqual(nativeLanguages, ['en', ...nativeCodes], 'the desktop application found them all');
  const languages = nativeCodes;

  // Which language: a saved choice always wins; without one the system decides.
  for (const [locale, language] of [['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh_TW', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'], ['ZH-cn', 'zh-CN'],
    ['ja', 'ja'], ['ja-JP', 'ja'], ['ja_JP', 'ja'], ['JA-jp', 'ja'], ['javanese', 'en'],
    ['en', 'en'], ['en-US', 'en'], [NO_SUCH_LANGUAGE, 'en'], [NO_SUCH_LANGUAGE + '-QA', 'en'], ['za', 'en'], ['', 'en'], [null, 'en'], [undefined, 'en']]) {
    assert.equal(languageForLocale(locale), language, String(locale));
  }
  for (const language of languages) {
    const main = language.split('-')[0];
    for (const locale of [language, language.toLowerCase(), language.toUpperCase(), language.replace(/-/g, '_')]) {
      assert.equal(languageForLocale(locale), language, locale + ' is ' + language);
    }
    assert.equal(languageForLocale(main + '-XX').split('-')[0], main, main + '-XX falls back to a language of the same family');
  }
  // The rule on its own, with languages that need not exist.
  assert.equal(languageForLocale('fr-CH', ['en', 'fr']), 'fr');
  assert.equal(languageForLocale('pt-PT', ['en', 'pt-BR']), 'pt-BR');
  assert.equal(languageForLocale('pt-PT', ['en', 'pt-PT', 'pt-BR']), 'pt-PT', 'the exact tag wins over the family');
  assert.equal(languageForLocale('de-DE', ['en', 'fr']), 'en');

  assert.equal(nativeLanguage({ home }), 'en', 'no saved choice and no system locale: English');
  assert.equal(nativeLanguage({ home, systemLocale: 'en-US' }), 'en');
  for (const language of languages) {
    assert.equal(nativeLanguage({ home, systemLocale: language }), language, 'the system language is used: ' + language);
    choose({ 'ssh-manager.language': 'en' });
    assert.equal(nativeLanguage({ home, systemLocale: language }), 'en', 'a saved English choice beats a ' + language + ' system');
    choose({ 'ssh-manager.language': language });
    assert.equal(nativeLanguage({ home, systemLocale: 'en-US' }), language, 'a saved ' + language + ' choice beats an English system');
    for (const unusable of ['{invalid', JSON.stringify({ 'ssh-manager.language': NO_SUCH_LANGUAGE }), JSON.stringify({ 'ssh-manager.language': 7 }), JSON.stringify({}), JSON.stringify([])]) {
      choose(unusable);
      assert.equal(nativeLanguage({ home, systemLocale: language }), language, 'unusable preferences fall back to the system: ' + unusable);
      assert.equal(nativeLanguage({ home, systemLocale: 'en-GB' }), 'en', 'unusable preferences fall back to the system: ' + unusable);
    }
  }

  // Text: English is the message itself; other languages come from catalogues.
  assert.equal(nativeText('File', {}, 'zh-CN'), '文件');
  assert.equal(nativeText('File', {}, 'en'), 'File');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'zh-CN'), '服务器（3）');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'en'), 'Servers (3)');
  assert.equal(nativeText('Not in the catalogue', {}, 'zh-CN'), 'Not in the catalogue', 'a missing entry shows the English text, never nothing');
  assert.equal(nativeText('File', {}, 'ja'), 'ファイル');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'ja'), 'サーバー (3)');
  assert.equal(nativeText('Not in the catalogue', {}, 'ja'), 'Not in the catalogue');
  assert.equal(nativeText('File', {}, NO_SUCH_LANGUAGE), 'File', 'an unsupported language falls back to English');
  for (const language of languages) {
    assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, language), JSON.parse(read(`desktop/electron/native.${language}.json`))['Servers ({{v0}})'].replace('{{v0}}', '3'), language);
  }

  // The application menu: every label is translated, and the native roles (shortcuts, behaviour) never change.
  // A few words are the same in many languages and may stay as they are.
  const INTERNATIONAL = new Set(['SSH Manager', 'Services', 'Zoom']);
  const flattenMenu = entries => entries.flatMap(entry => [entry, ...flattenMenu(entry.submenu || [])]);
  for (const isMac of [true, false]) {
    const en = flattenMenu(applicationMenuTemplate({ isMac, language: 'en' }));
    assert.equal(en.find(entry => entry.role === 'help').label, 'Help');
    for (const language of languages) {
      const menu = flattenMenu(applicationMenuTemplate({ isMac, language }));
      assert.equal(menu.length, en.length, language);
      for (let i = 0; i < menu.length; i++) {
        assert.ok(!['appMenu', 'editMenu', 'windowMenu'].includes(menu[i].role), 'no automatically generated English submenu');
        if (en[i].label && !INTERNATIONAL.has(en[i].label)) {
          assert.notEqual(menu[i].label, en[i].label, en[i].label + ' has a ' + language + ' label');
        }
        assert.equal(menu[i].role, en[i].role, language + ' preserves native menu actions');
        assert.equal(menu[i].accelerator, en[i].accelerator, language + ' preserves shortcuts');
      }
      assert.equal(menu.find(entry => entry.role === 'help').label, nativeText('Help', {}, language));
      if (isMac) assert.equal(menu.find(entry => entry.role === 'quit').label, nativeText('Quit SSH Manager', {}, language));
    }
  }
  assert.equal(flattenMenu(applicationMenuTemplate({ isMac: true, language: 'zh-CN' })).find(entry => entry.role === 'help').label, '帮助');
  assert.equal(flattenMenu(applicationMenuTemplate({ isMac: true, language: 'zh-CN' })).find(entry => entry.role === 'quit').label, '退出 SSH Manager');
  assert.equal(flattenMenu(applicationMenuTemplate({ isMac: true, language: 'ja' })).find(entry => entry.role === 'help').label, 'ヘルプ');

  // Every sentence the application passes to its text() helper has a translated entry.
  const catalogue = Object.fromEntries(languages.map(language => [language, JSON.parse(read(`desktop/electron/native.${language}.json`))]));
  for (const language of languages) {
    assert.deepEqual(Object.keys(catalogue[language]).sort(), Object.keys(catalogue[languages[0]]).sort(), language + ' covers every native surface');
  }
  const unescape = body => body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
  const used = new Set();
  for (const match of read('desktop/electron/main.js').matchAll(/\btext\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g)) {
    used.add([...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(part => unescape(part[1])).join(''));
  }
  assert.ok(used.size >= 20, 'found the text() calls in main.js (' + used.size + ')');
  for (const language of languages) {
    for (const message of used) assert.ok(catalogue[language][message]?.trim(), `native.${language}.json lacks: ` + message);
    for (const [message, translated] of Object.entries(catalogue[language])) {
      assert.ok(translated.trim(), language + ': ' + message);
      assert.deepEqual(message.match(/\{\{\w+\}\}/g)?.sort(), translated.match(/\{\{\w+\}\}/g)?.sort(), 'placeholders differ: ' + language + ': ' + message);
    }
  }

  // The Windows installer has a page for each language it knows one for.
  const pages = /installerLanguages:\s*\[([^\]]*)\]/.exec(read('desktop/electron/electron-builder.yml'))?.[1].split(',').map(page => page.trim());
  assert.ok(pages?.includes('en_US'), 'the installer keeps its English page');
  for (const language of languages) {
    const page = installerLocaleFor(language);
    if (page) assert.ok(pages.includes(page), `the installer has no ${page} page for ${language}: npm run lang -- add lists it`);
  }

  // The interface catalogues: same keys, same placeholders, nothing empty.
  const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]);
  for (const namespace of ['messages.', '']) {
    const en = JSON.parse(read('ui/src/locales/' + namespace + 'en.json'));
    const left = Object.fromEntries(flatten(en));
    for (const language of languages) {
      const translated = JSON.parse(read('ui/src/locales/' + namespace + language + '.json'));
      const right = Object.fromEntries(flatten(translated));
      assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), language);
      for (const key of Object.keys(left)) {
        assert.ok(right[key].trim(), language + ': ' + key);
        assert.deepEqual(left[key].match(/\{\{\w+\}\}/g)?.sort(), right[key].match(/\{\{\w+\}\}/g)?.sort(), language + ': ' + key);
      }
    }
    if (namespace) for (const key of Object.keys(left)) assert.equal(left[key], key, 'the English catalogue is the key itself: ' + key);
  }

  // Each language names itself (the selector shows it) and has the word for "Language" (so the selector can be found from any language).
  const names = new Set();
  for (const language of ['en', ...languages]) {
    const { name, label } = JSON.parse(read(`ui/src/locales/${language}.json`)).language ?? {};
    assert.ok(name?.trim() && label?.trim(), language + ' has language.name and language.label');
    assert.ok(!names.has(name), 'two languages are both called ' + name);
    names.add(name);
  }

  // Every sentence written as tr('…') / trn(n, '…', '…') is in each translated catalogue,
  // so no translated screen quietly falls back to English.
  const catalogues = languages.map(language => [language, JSON.parse(read(`ui/src/locales/messages.${language}.json`))]);
  const walk = dir => fs.readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : /\.tsx?$/.test(entry.name) ? [dir + '/' + entry.name] : []);
  const literal = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;
  const sentences = new Set();
  // Read the body of a JavaScript string literal character by character, never by pattern: every escape sequence
  // is passed on to JSON as it is (backslashes included) except an escaped single quote, which loses its backslash,
  // and a bare double quote is escaped for JSON.
  const decode = body => {
    let json = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') { const escaped = body[++i]; json += escaped === "'" ? "'" : '\\' + escaped; }
      else json += body[i] === '"' ? '\\"' : body[i];
    }
    return JSON.parse('"' + json + '"');
  };
  const add = (single, double) => sentences.add(decode(single !== undefined ? single : double));
  for (const file of walk('ui/src')) {
    const source = read(file);
    for (const match of source.matchAll(new RegExp(String.raw`\btr\(\s*` + literal, 'g'))) add(match[1], match[2]);
    for (const match of source.matchAll(new RegExp(String.raw`\btrn\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*` + literal + String.raw`\s*,\s*` + literal, 'g'))) {
      add(match[1], match[2]); add(match[3], match[4]);
    }
  }
  assert.ok(sentences.size > 300, 'found the interface sentences (' + sentences.size + ')');
  for (const [language, translated] of catalogues) {
    for (const sentence of sentences) assert.ok(translated[sentence]?.trim(), `messages.${language}.json lacks: ` + sentence);
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
console.log('Language choice, native text, catalogue and coverage checks passed.');
