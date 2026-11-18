import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Strings of the application's own native surfaces (menus, tray, notifications)
// in Chinese and Japanese. English is the key itself, so it needs no catalogue.
const messages = Object.fromEntries(['zh-CN', 'ja'].map(language => [
  language,
  JSON.parse(fs.readFileSync(new URL(`./native.${language}.json`, import.meta.url), 'utf8')),
]));

/** Map a system locale tag to a supported language. */
export function languageForLocale(locale) {
  if (/^zh(?:[-_]|$)/i.test(String(locale ?? ''))) return 'zh-CN';
  return /^ja(?:[-_]|$)/i.test(String(locale ?? '')) ? 'ja' : 'en';
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
    if (saved === 'en' || saved === 'zh-CN' || saved === 'ja') return saved;
  } catch { /* no preferences yet, or unreadable: fall through to the system */ }
  return languageForLocale(systemLocale);
}

export function nativeText(message, values = {}, language = nativeLanguage()) {
  const text = messages[language]?.[message] || message;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => String(values[key] ?? match));
}
