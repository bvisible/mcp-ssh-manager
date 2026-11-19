import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strings of the application's own native surfaces (menus, tray, notifications).
// English is the key itself, so it needs no catalogue; every other language is a
// file next to this one, `native.<code>.json`, found here at start. Nothing in
// this module names a language: adding the file adds the language (`npm run lang`,
// ui/README.md "Adding a language"). The same codes exist in ui/src/locales.
const folder = path.dirname(fileURLToPath(import.meta.url));
const messages = new Map();
for (const file of fs.readdirSync(folder)) {
  const code = /^native\.([A-Za-z0-9-]+)\.json$/.exec(file)?.[1];
  if (code) messages.set(code, JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')));
}

/** The languages the native surfaces speak: English, then the catalogues found, by code. */
export const nativeLanguages = ['en', ...[...messages.keys()].sort()];

/**
 * Map a system locale tag to a language that exists: the tag itself (`zh-CN`), else
 * the first language with the same main subtag (`zh-TW` -> `zh-CN`, `fr-CH` -> `fr`),
 * else English. The same rule as `languageFor` in ui/src/lib/i18n.ts.
 */
export function languageForLocale(locale, available = nativeLanguages) {
  const tag = String(locale ?? '').replace(/_/g, '-').toLowerCase();
  if (!tag) return 'en';
  const exact = available.find(code => code.toLowerCase() === tag);
  if (exact) return exact;
  const main = tag.split('-')[0];
  return available.find(code => code.toLowerCase().split('-')[0] === main) ?? 'en';
}

/**
 * Which language the native menus and notifications speak.
 *
 * The choice saved from the interface (Options -> Appearance) always wins. Until
 * somebody has chosen, the system language decides. The system locale is a
 * parameter, not a lookup, so this module stays importable from plain Node (the
 * tests do) and never needs Electron: the application passes `app.getLocale()`.
 */
export function nativeLanguage({ home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager'), systemLocale = '' } = {}) {
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(home, 'preferences.json'), 'utf8'));
    const saved = preferences['ssh-manager.language'];
    if (typeof saved === 'string' && nativeLanguages.includes(saved)) return saved;
  } catch { /* no preferences yet, or unreadable: fall through to the system */ }
  return languageForLocale(systemLocale);
}

export function nativeText(message, values = {}, language = nativeLanguage()) {
  const text = messages.get(language)?.[message] || message;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => String(values[key] ?? match));
}
