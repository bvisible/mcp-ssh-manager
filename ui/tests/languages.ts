// The languages the interface ships, read from its catalogues, so a test never lists them by hand:
// adding a language adds it to every test that loops over this.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('../src/locales/', import.meta.url));
const read = (name: string) => JSON.parse(fs.readFileSync(folder + name, 'utf8'));

export interface Language {
  code: string;
  /** The language written in itself, as the selector shows it. */
  name: string;
  /** The word for "Language" in it. */
  label: string;
  /** The welcome title of the first-run dialog. */
  welcome: string;
}

export const languages: Language[] = fs.readdirSync(folder)
  .map(file => /^([A-Za-z0-9-]+)\.json$/.exec(file)?.[1])
  .filter((code): code is string => Boolean(code) && fs.existsSync(`${folder}messages.${code}.json`))
  .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
  .map(code => ({
    code,
    name: read(`${code}.json`).language.name,
    label: read(`${code}.json`).language.label,
    welcome: read(`messages.${code}.json`)['Your servers. Your workspace.'],
  }));

/** The selector's accessible name: every language's word for "Language", so it is found from any of them. */
export const selectorLabel = languages.map(language => language.label).join(' / ');
/** What the selector's options say, in order. */
export const selectorNames = languages.map(language => language.name);

/** A browser locale no shipped language answers to, for the "unsupported falls back to English" case. */
export const unsupportedLocale = ['ko-KR', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR']
  .find(locale => !languages.some(language => language.code.split('-')[0] === locale.split('-')[0]))!;
