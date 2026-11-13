import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const messages = JSON.parse(fs.readFileSync(new URL('./native.zh-CN.json', import.meta.url), 'utf8'));
export function nativeLanguage(home = process.env.SSH_MANAGER_HOME || path.join(os.homedir(), '.ssh-manager')) {
  try {
    const preferences = JSON.parse(fs.readFileSync(path.join(home, 'preferences.json'), 'utf8'));
    return preferences['ssh-manager.language'] === 'en' ? 'en' : 'zh-CN';
  } catch { return 'zh-CN'; }
}
export function nativeText(message, values = {}, language = nativeLanguage()) {
  const text = language === 'en' ? message : messages[message] || message;
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => String(values[key] ?? match));
}
