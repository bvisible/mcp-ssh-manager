/**
 * Translations. A language is files in `src/locales`, and nothing in this module
 * names one: the catalogues are found at build time, the selector in Options is
 * built from them, and the language of the system is matched against them.
 *
 *   <code>.json            the labels of the components carried over from TransHub
 *                          (dotted keys, `files.contextOpen`), read through `t()`.
 *                          It also holds `language.name` (the language written in
 *                          itself, "Français") and `language.label` (the word for
 *                          "Language", so the selector can be found from any language).
 *   messages.<code>.json   everything written for this project. The keys are the
 *                          English sentences themselves, read through `tr()`, so a
 *                          reviewer sees the real text at the call site and English
 *                          can never drift from its key.
 *
 * `en` is the source and the fallback. To add a language: `npm run lang -- add <code>`
 * (ui/README.md, "Adding a language").
 *
 * What is translated is the interface's own wording. Server names, commands,
 * paths and anything a remote machine or the engine prints stay as they are.
 *
 * Which language is shown: the one chosen under Options → Appearance, which is
 * saved with the other preferences. Until one is chosen, the browser's (or the
 * desktop application's) language decides, matched against the languages that
 * exist, and English when none matches.
 */
import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { readPreference, writePreference } from '@/lib/preferences';

type Catalogue = Record<string, any>;

// Root-absolute globs (relative to the interface's folder): found when the interface is built.
const labelFiles = import.meta.glob<Catalogue>('/src/locales/*.json', { eager: true, import: 'default' });
const sentenceFiles = import.meta.glob<Record<string, string>>('/src/locales/messages.*.json', { eager: true, import: 'default' });

/** `/src/locales/fr.json` → `fr`; `/src/locales/messages.fr.json` is not a label file. */
const codeOf = (file: string, prefix = '') => new RegExp(`/${prefix}([A-Za-z0-9-]+)\\.json$`).exec(file)?.[1];
const labels = new Map<string, Catalogue>();
for (const [file, content] of Object.entries(labelFiles)) {
  const code = codeOf(file);
  if (code) labels.set(code, content);
}
const sentences = new Map<string, Record<string, string>>();
for (const [file, content] of Object.entries(sentenceFiles)) {
  const code = codeOf(file, 'messages\\.');
  if (code) sentences.set(code, content);
}

/** A language is complete when it has both catalogues; English first, then by code. */
export type Language = string;
export interface LanguageInfo { code: Language; name: string; label: string }
export const languages: LanguageInfo[] = [...labels.keys()]
  .filter(code => sentences.has(code))
  .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
  .map(code => ({ code, name: labels.get(code)?.language?.name ?? code, label: labels.get(code)?.language?.label ?? 'Language' }));
const codes = languages.map(language => language.code);
export const LANGUAGE_KEY = 'ssh-manager.language';

void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(codes.map(code => [code, { translation: labels.get(code) ?? {}, messages: sentences.get(code) ?? {} }])),
  lng: 'en', fallbackLng: 'en', supportedLngs: codes,
  interpolation: { escapeValue: false }, returnEmptyString: false,
});

/**
 * Map a system or browser locale tag to a language that exists: the tag itself
 * (`zh-CN`), else the first language with the same main subtag (`zh-TW` → `zh-CN`,
 * `fr-CH` → `fr`), else English.
 */
export function languageFor(locale: string | null | undefined, available: readonly string[] = codes): Language {
  const tag = String(locale ?? '').replace(/_/g, '-').toLowerCase();
  if (!tag) return 'en';
  const exact = available.find(code => code.toLowerCase() === tag);
  if (exact) return exact;
  const main = tag.split('-')[0];
  return available.find(code => code.toLowerCase().split('-')[0] === main) ?? 'en';
}

/** Literal message keys keep source text reviewable; identifiers and remote data never enter this function. */
export function tr(message: string, values?: Record<string, string | number | undefined>): string {
  return String(i18n.t(message, { ns: 'messages', keySeparator: false, nsSeparator: false, ...values }));
}

/**
 * A message with an English singular and plural. A language with no plural (Chinese,
 * Japanese) carries the same translation in both entries; one with the English two
 * forms (French, German, Spanish...) translates each. The count is available to the
 * text as `{{n}}`. A language that needs more than two forms is not covered by this.
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
  const language = instance.resolvedLanguage ?? 'en';
  return codes.includes(language) ? language : 'en';
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
  const language: Language = typeof saved === 'string' && codes.includes(saved)
    ? saved
    : languageFor(typeof navigator === 'undefined' ? '' : navigator.language);
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

export default i18n;
