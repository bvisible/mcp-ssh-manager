import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLanguage, installerLocaleFor, languageStatus } from '../scripts/language.mjs';

// `npm run lang -- add` on a throwaway copy of the files a language is made of: what it creates,
// what it refuses, and that what it creates has the same shape as the languages that ship.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-lang-tool-'));
// Languages the installer has a page for and that are not shipped: picked at run time, so shipping one later never breaks this test.
const shipped = fs.readdirSync(path.join(repository, 'ui/src/locales')).map(name => /^([A-Za-z0-9-]+)\.json$/.exec(name)?.[1]).filter(Boolean);
const [first, second, third] = ['de', 'sv', 'nl', 'it', 'pl', 'ru', 'tr', 'ko', 'cs', 'da'].filter(code => !shipped.includes(code));
assert.ok(third, 'three installable languages are still free for this test');
const copy = relative => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.copyFileSync(path.join(repository, relative), path.join(root, relative));
};
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]);
const placeholders = text => String(text).match(/\{\{\w+\}\}/g)?.sort();
try {
  for (const name of fs.readdirSync(path.join(repository, 'ui/src/locales'))) if (name.endsWith('.json')) copy('ui/src/locales/' + name);
  for (const name of fs.readdirSync(path.join(repository, 'desktop/electron'))) if (/^native\..*\.json$/.test(name)) copy('desktop/electron/' + name);
  copy('desktop/electron/electron-builder.yml');
  const builder = () => fs.readFileSync(path.join(root, 'desktop/electron/electron-builder.yml'), 'utf8');
  const before = Object.fromEntries(fs.readdirSync(path.join(root, 'ui/src/locales')).map(name => [name, fs.readFileSync(path.join(root, 'ui/src/locales', name), 'utf8')]));

  // A language the installer has a page for.
  const done = addLanguage(root, first, { name: 'Test name', label: 'Test label' });
  assert.deepEqual(done.files.sort(), [`desktop/electron/native.${first}.json`, `ui/src/locales/${first}.json`, `ui/src/locales/messages.${first}.json`]);
  assert.equal(done.installer, installerLocaleFor(first));
  assert.match(builder(), new RegExp(`installerLanguages: \\[[^\\]]*\\b${installerLocaleFor(first)}\\b[^\\]]*\\]`));
  assert.match(builder(), /installerLanguages: \[en_US,/, 'the pages already there stay, in order');
  assert.equal(readJson(`ui/src/locales/${first}.json`).language.name, 'Test name');
  assert.equal(readJson(`ui/src/locales/${first}.json`).language.label, 'Test label');

  // The new catalogues have exactly the shape of the shipped ones: same keys, same placeholders, English text to translate.
  const english = Object.fromEntries(flatten(readJson('ui/src/locales/en.json')));
  const labels = Object.fromEntries(flatten(readJson(`ui/src/locales/${first}.json`)));
  assert.deepEqual(Object.keys(labels).sort(), Object.keys(english).sort());
  for (const key of Object.keys(english)) if (!key.startsWith('language.')) assert.equal(labels[key], english[key], key);
  const sentences = readJson(`ui/src/locales/messages.${first}.json`);
  assert.deepEqual(Object.keys(sentences), Object.keys(readJson('ui/src/locales/messages.en.json')));
  for (const [key, value] of Object.entries(sentences)) assert.equal(value, key);
  const natives = readJson(`desktop/electron/native.${first}.json`);
  assert.deepEqual(Object.keys(natives).sort(), Object.keys(readJson('desktop/electron/native.zh-CN.json')).sort());
  for (const [key, value] of Object.entries(natives)) { assert.equal(value, key); assert.deepEqual(placeholders(key), placeholders(value)); }
  for (const name of Object.keys(before)) assert.equal(fs.readFileSync(path.join(root, 'ui/src/locales', name), 'utf8'), before[name], name + ' was not touched');

  // `status` reports a new language as entirely English and the shipped ones as translated.
  const status = Object.fromEntries(languageStatus(root).map(row => [row.code, row]));
  assert.ok(status[first].sentences.total > 300 && status[first].sentences.same === status[first].sentences.total, 'a fresh language is all English');
  assert.ok(status[first].menus.total > 20 && status[first].menus.same === status[first].menus.total);
  assert.ok(status[first].labels.same > 0 && status[first].labels.total > 0);
  assert.equal(status['zh-CN'].sentences.same < status['zh-CN'].sentences.total / 10, true, 'a shipped language is translated');
  assert.equal(status[first].name, 'Test name');

  // A language with no installer page still gets its catalogues, and the name defaults to the language written in itself.
  const unknown = addLanguage(root, 'qaa');
  assert.equal(unknown.installer, undefined);
  assert.equal(unknown.installerKnown, false);
  assert.equal(readJson('ui/src/locales/qaa.json').language.name, 'qaa', 'no name known for the code: the code itself');
  const named = addLanguage(root, second);
  assert.ok(readJson(`ui/src/locales/${second}.json`).language.name.length > 2);
  assert.notEqual(readJson(`ui/src/locales/${second}.json`).language.name, second, 'the name comes from the platform when it knows it');
  assert.equal(named.installer, installerLocaleFor(second));
  const listed = /installerLanguages: \[([^\]]*)\]/.exec(builder())[1].split(',').map(page => page.trim());
  assert.deepEqual(listed, [...new Set(listed)], 'a page is never listed twice');

  // Refusals: nothing is written when the code is wrong or the language exists.
  const snapshot = () => JSON.stringify([fs.readdirSync(path.join(root, 'ui/src/locales')), fs.readdirSync(path.join(root, 'desktop/electron')), builder()]);
  const state = snapshot();
  for (const [code, reason] of [['en', /source language/], [first, /already exists/], ['zh-CN', /already exists/], ['zh-cn', /already exists/], ['ZH-cn', /already exists/],
    ['zh_CN', /not a language code/], ['../evil', /not a language code/], ['', /not a language code/], ['French', /not a language code/], ['f', /not a language code/]]) {
    assert.throws(() => addLanguage(root, code), reason, 'refused: ' + JSON.stringify(code));
  }
  assert.equal(snapshot(), state, 'a refused request writes nothing');

  // The command line: output, exit codes, and the real tool never touches the working tree it is told to leave alone.
  const run = (...args) => spawnSync(process.execPath, [path.join(repository, 'scripts/language.mjs'), ...args, '--root', root], { encoding: 'utf8' });
  const cli = run('add', third, '--name', 'Nom', '--label', 'Libellé');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`ui/src/locales/${third}\\.json`));
  assert.match(cli.stdout, new RegExp(`installer page ${installerLocaleFor(third)}`));
  assert.match(cli.stdout, /npm run test:locale/);
  const again = run('add', third);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  const table = run('status');
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, new RegExp(`^${third}\\s+Nom\\s`, 'm'));
  assert.match(table.stdout, /^zh-CN\s+简体中文\s/m);
  assert.equal(run().status, 2, 'no command: usage and exit code 2');
  assert.equal(run('add').status, 2, 'add without a code: usage');

  // The installer page table: a code with a region falls back to its family, and an unknown language has none.
  assert.equal(installerLocaleFor('fr'), 'fr_FR');
  assert.equal(installerLocaleFor('fr-CH'), 'fr_FR');
  assert.equal(installerLocaleFor('pt-BR'), 'pt_BR');
  assert.equal(installerLocaleFor('zh-CN'), 'zh_CN');
  assert.equal(installerLocaleFor('qaa'), undefined);

  // The real tree is exactly as it was: nothing the tool made in the copy reached it.
  for (const code of [first, second, third]) {
    assert.equal(fs.existsSync(path.join(repository, `ui/src/locales/${code}.json`)), false, code + ' was made in the copy only');
    assert.equal(fs.existsSync(path.join(repository, `desktop/electron/native.${code}.json`)), false, code + ' was made in the copy only');
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Language tool checks passed.');
