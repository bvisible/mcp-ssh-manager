import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { languageForLocale, nativeLanguage, nativeText } from '../desktop/electron/locale.mjs';
import { applicationMenuTemplate } from '../desktop/electron/native-menu.mjs';

const read = relative => fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-locale-'));
const choose = value => fs.writeFileSync(path.join(home, 'preferences.json'), typeof value === 'string' ? value : JSON.stringify(value));
try {
  // Which language: a saved choice always wins; without one the system decides.
  for (const [locale, language] of [['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh_TW', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'], ['ZH-cn', 'zh-CN'],
    ['en', 'en'], ['en-US', 'en'], ['fr-FR', 'en'], ['de', 'en'], ['za', 'en'], ['', 'en'], [undefined, 'en']]) {
    assert.equal(languageForLocale(locale), language, String(locale));
  }
  assert.equal(nativeLanguage({ home }), 'en', 'no saved choice and no system locale: English');
  assert.equal(nativeLanguage({ home, systemLocale: 'en-US' }), 'en');
  assert.equal(nativeLanguage({ home, systemLocale: 'zh-CN' }), 'zh-CN');
  choose({ 'ssh-manager.language': 'en' });
  assert.equal(nativeLanguage({ home, systemLocale: 'zh-CN' }), 'en', 'a saved English choice beats a Chinese system');
  choose({ 'ssh-manager.language': 'zh-CN' });
  assert.equal(nativeLanguage({ home, systemLocale: 'en-US' }), 'zh-CN', 'a saved Chinese choice beats an English system');
  for (const unusable of ['{invalid', JSON.stringify({ 'ssh-manager.language': 'fr' }), JSON.stringify({}), JSON.stringify([])]) {
    choose(unusable);
    assert.equal(nativeLanguage({ home, systemLocale: 'zh-CN' }), 'zh-CN', 'unusable preferences fall back to the system: ' + unusable);
    assert.equal(nativeLanguage({ home, systemLocale: 'en-GB' }), 'en', 'unusable preferences fall back to the system: ' + unusable);
  }

  // Text: English is the message itself, Chinese comes from the catalogue.
  assert.equal(nativeText('File', {}, 'zh-CN'), '文件');
  assert.equal(nativeText('File', {}, 'en'), 'File');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'zh-CN'), '服务器（3）');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'en'), 'Servers (3)');
  assert.equal(nativeText('Not in the catalogue', {}, 'zh-CN'), 'Not in the catalogue', 'a missing entry shows the English text, never nothing');

  // The application menu: every label is translated, and the native roles (shortcuts, behaviour) never change.
  const flattenMenu = entries => entries.flatMap(entry => [entry, ...flattenMenu(entry.submenu || [])]);
  for (const isMac of [true, false]) {
    const zh = flattenMenu(applicationMenuTemplate({ isMac, language: 'zh-CN' }));
    const en = flattenMenu(applicationMenuTemplate({ isMac, language: 'en' }));
    assert.equal(zh.length, en.length);
    for (let i = 0; i < zh.length; i++) {
      assert.ok(!['appMenu', 'editMenu', 'windowMenu'].includes(zh[i].role), 'no automatically generated English submenu');
      if (en[i].label && en[i].label !== 'SSH Manager') {
        assert.notEqual(zh[i].label, en[i].label, en[i].label + ' has a Chinese label');
      }
      assert.equal(zh[i].role, en[i].role, 'language preserves native menu actions');
    }
    assert.equal(zh.find(entry => entry.role === 'help').label, '帮助');
    assert.equal(en.find(entry => entry.role === 'help').label, 'Help');
    if (isMac) assert.equal(zh.find(entry => entry.role === 'quit').label, '退出 SSH Manager');
  }

  // Every sentence the application passes to its text() helper has a Chinese entry.
  const native = JSON.parse(read('desktop/electron/native.zh-CN.json'));
  const unescape = body => body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
  const used = new Set();
  for (const match of read('desktop/electron/main.js').matchAll(/\btext\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)/g)) {
    used.add([...match[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(part => unescape(part[1])).join(''));
  }
  assert.ok(used.size >= 20, 'found the text() calls in main.js (' + used.size + ')');
  for (const message of used) assert.ok(native[message]?.trim(), 'native.zh-CN.json lacks: ' + message);
  for (const [message, chinese] of Object.entries(native)) {
    assert.deepEqual(message.match(/\{\{\w+\}\}/g)?.sort(), chinese.match(/\{\{\w+\}\}/g)?.sort(), 'placeholders differ: ' + message);
  }

  // The interface catalogues: same keys, same placeholders, nothing empty.
  const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]);
  for (const namespace of ['messages.', '']) {
    const en = JSON.parse(read('ui/src/locales/' + namespace + 'en.json'));
    const zh = JSON.parse(read('ui/src/locales/' + namespace + 'zh-CN.json'));
    const left = Object.fromEntries(flatten(en)), right = Object.fromEntries(flatten(zh));
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
    for (const key of Object.keys(left)) {
      assert.ok(right[key].trim(), key);
      assert.deepEqual(left[key].match(/\{\{\w+\}\}/g)?.sort(), right[key].match(/\{\{\w+\}\}/g)?.sort(), key);
    }
    if (namespace) for (const key of Object.keys(left)) assert.equal(left[key], key, 'the English catalogue is the key itself: ' + key);
  }

  // Every sentence written as tr('…') / trn(n, '…', '…') in the interface is in both catalogues,
  // so no Chinese screen quietly falls back to English.
  const catalogue = JSON.parse(read('ui/src/locales/messages.zh-CN.json'));
  const walk = dir => fs.readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : /\.tsx?$/.test(entry.name) ? [dir + '/' + entry.name] : []);
  const literal = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;
  const sentences = new Set();
  const add = (single, double) => sentences.add(JSON.parse('"' + (single !== undefined ? single.replace(/\\'/g, "'").replace(/"/g, '\\"') : double) + '"'));
  for (const file of walk('ui/src')) {
    const source = read(file);
    for (const match of source.matchAll(new RegExp(String.raw`\btr\(\s*` + literal, 'g'))) add(match[1], match[2]);
    for (const match of source.matchAll(new RegExp(String.raw`\btrn\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*` + literal + String.raw`\s*,\s*` + literal, 'g'))) {
      add(match[1], match[2]); add(match[3], match[4]);
    }
  }
  assert.ok(sentences.size > 300, 'found the interface sentences (' + sentences.size + ')');
  for (const sentence of sentences) assert.ok(catalogue[sentence]?.trim(), 'messages.zh-CN.json lacks: ' + sentence);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
console.log('Language choice, native text, catalogue and coverage checks passed.');
