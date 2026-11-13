import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import en from '@/locales/en.json';
import zh from '@/locales/zh-CN.json';
import messagesEn from '@/locales/messages.en.json';
import messagesZh from '@/locales/messages.zh-CN.json';
import { readPreference, writePreference } from '@/lib/preferences';

export type Language = 'zh-CN' | 'en';
export const LANGUAGE_KEY = 'ssh-manager.language';
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en, messages: messagesEn },
    'zh-CN': { translation: zh, messages: messagesZh },
  },
  lng: 'zh-CN', fallbackLng: 'en', supportedLngs: ['zh-CN', 'en'],
  interpolation: { escapeValue: false }, returnEmptyString: false,
});
/** Literal message keys keep source text reviewable; identifiers and remote data never enter this function. */
export function tr(message: string, values?: Record<string, string | number | undefined>): string {
  return String(i18n.t(message, { ns: 'messages', keySeparator: false, nsSeparator: false, ...values }));
}
export function useLocale() {
  const { i18n: instance } = useTranslation();
  return instance.resolvedLanguage === 'en' ? 'en' : 'zh-CN';
}
export async function setLanguage(language: Language): Promise<void> {
  writePreference(LANGUAGE_KEY, language);
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}
/** Hydrated server preferences survive the control plane choosing a new port. */
export async function initializeLanguage(): Promise<void> {
  const saved = readPreference(LANGUAGE_KEY);
  await i18n.changeLanguage(saved === 'en' ? 'en' : 'zh-CN');
  document.documentElement.lang = saved === 'en' ? 'en' : 'zh-CN';
}
export default i18n;
