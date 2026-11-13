import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeLanguage, nativeText } from '../desktop/electron/locale.mjs';
import { applicationMenuTemplate } from '../desktop/electron/native-menu.mjs';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-locale-'));
try {
  assert.equal(nativeLanguage(home), 'zh-CN');
  fs.writeFileSync(path.join(home, 'preferences.json'), JSON.stringify({ 'ssh-manager.language': 'en' }));
  assert.equal(nativeLanguage(home), 'en');
  fs.writeFileSync(path.join(home, 'preferences.json'), '{invalid');
  assert.equal(nativeLanguage(home), 'zh-CN');
  assert.equal(nativeText('File', {}, 'zh-CN'), '文件');
  assert.equal(nativeText('File', {}, 'en'), 'File');
  assert.equal(nativeText('Servers ({{v0}})', { v0: 3 }, 'zh-CN'), '服务器（3）');
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
    if (isMac) assert.equal(zh.find(entry => entry.role === 'quit').label, '退出 SSH Manager');
  }
  for (const namespace of ['messages.', '']) {
    const en = JSON.parse(fs.readFileSync(new URL('../ui/src/locales/' + namespace + 'en.json', import.meta.url)));
    const zh = JSON.parse(fs.readFileSync(new URL('../ui/src/locales/' + namespace + 'zh-CN.json', import.meta.url)));
    const flatten = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flatten(v, prefix + k + '.') : [[prefix + k, v]]);
    const left = Object.fromEntries(flatten(en)), right = Object.fromEntries(flatten(zh));
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
    for (const key of Object.keys(left)) {
      assert.ok(right[key].trim(), key);
      assert.deepEqual(left[key].match(/\{\{\w+\}\}/g)?.sort(), right[key].match(/\{\{\w+\}\}/g)?.sort(), key);
    }
  }
} finally { fs.rmSync(home, { recursive: true, force: true }); }
console.log('Language catalog, interpolation and native persistence checks passed.');
