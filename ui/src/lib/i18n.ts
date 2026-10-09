/**
 * Translations for the components carried over from TransHub.
 *
 * They call `t()` throughout, and stripping that out would have meant editing
 * every one of them — the opposite of what a port should do. The catalogue is
 * TransHub's own English strings, narrowed to the keys these components use.
 *
 * English only for now: the engine's own output has never been translated, and
 * a half-translated interface is worse than an untranslated one.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/locales/en.json';

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  // A missing key renders as the key itself, which is visible in review rather
  // than silently blank.
  returnEmptyString: false,
});

export default i18n;
