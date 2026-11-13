/**
 * Translations: English, and Simplified Chinese.
 *
 * Two catalogues share one i18next instance:
 *
 * - `translation` holds the dotted keys (`files.contextOpen`) of the components
 *   carried over from TransHub, which call `t()` throughout.
 * - `messages` holds everything written for this project. Its keys are the
 *   English sentences themselves, read through `tr()`, so a reviewer sees the
 *   real text at the call site and English can never drift from its key.
 *
 * What is translated is the interface's own wording. Server names, commands,
 * paths and anything a remote machine or the engine prints stay as they are.
 *
 * Which language is shown: the one chosen under Options → Appearance, which is
 * saved with the other preferences. Until one is chosen, the browser's (or the
 * desktop application's) language decides — Chinese for any `zh` locale,
 * English for everything else.
 */
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
  lng: 'en', fallbackLng: 'en', supportedLngs: ['zh-CN', 'en'],
  interpolation: { escapeValue: false }, returnEmptyString: false,
});

/** The language a system or browser locale asks for: Chinese for any `zh` tag, English otherwise. */
export function languageFor(locale: string | null | undefined): Language {
  return /^zh(?:[-_]|$)/i.test(locale ?? '') ? 'zh-CN' : 'en';
}

/** Literal message keys keep source text reviewable; identifiers and remote data never enter this function. */
export function tr(message: string, values?: Record<string, string | number | undefined>): string {
  return String(i18n.t(message, { ns: 'messages', keySeparator: false, nsSeparator: false, ...values }));
}

/**
 * A message with an English singular and plural. Chinese has no plural, so
 * both entries of a catalogue simply carry the same translation. The count is
 * available to the text as `{{n}}`.
 */
export function trn(
  count: number,
  one: string,
  other: string,
  values?: Record<string, string | number | undefined>,
): string {
  return tr(count === 1 ? one : other, { n: count, ...values });
}

/** The language in use. Calling it subscribes the component, so it redraws when the language changes. */
export function useLocale(): Language {
  const { i18n: instance } = useTranslation();
  return instance.resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
}

export async function setLanguage(language: Language): Promise<void> {
  writePreference(LANGUAGE_KEY, language);
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

/**
 * Pick the language before the first paint. A saved choice always wins;
 * without one the browser's language decides, and nothing is saved, so the
 * interface keeps following the system until somebody chooses.
 *
 * Hydrated server preferences survive the control plane choosing a new port.
 */
export async function initializeLanguage(): Promise<void> {
  const saved = readPreference(LANGUAGE_KEY);
  const language: Language = saved === 'en' || saved === 'zh-CN'
    ? saved
    : languageFor(typeof navigator === 'undefined' ? '' : navigator.language);
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

export default i18n;
