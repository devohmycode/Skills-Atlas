import type { Theme } from '../types.js';
import { de } from './de.js';
import { en, type Messages } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import { it } from './it.js';
import { ja } from './ja.js';
import { ko } from './ko.js';
import { pt } from './pt.js';
import { zh } from './zh.js';

/**
 * Available translations. Adding a language = one file implementing `Messages`, one entry here
 * and its locale in LOCALES (the tests check that every theme is translated).
 */
export const LANGUAGES = { en, fr, es, pt, de, it, zh, ja, ko } satisfies Record<string, Messages>;
export type Lang = keyof typeof LANGUAGES;
export const DEFAULT_LANG: Lang = 'en';

/** Locale used to format numbers (`79,668`, `79 668`…), also sent to the web page. */
export const LOCALES: Record<Lang, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-419',
  pt: 'pt-BR',
  de: 'de-DE',
  it: 'it-IT',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

let current: Lang = DEFAULT_LANG;

export function isLang(value: string | undefined): value is Lang {
  return !!value && Object.hasOwn(LANGUAGES, value);
}

/** Accepts `fr`, `FR`, `fr-FR`, `fr_FR.UTF-8`… */
export function normalizeLang(value: string | undefined): Lang | undefined {
  const code = value?.trim().toLowerCase().split(/[-_.]/)[0];
  return isLang(code) ? code : undefined;
}

/**
 * Language of the system, when it is one we have: LC_ALL, LC_MESSAGES or LANG (Unix), else the
 * locale Node gets from the OS (Windows sets no LANG). `C` and `POSIX` mean "no preference".
 */
export function systemLang(
  env: Record<string, string | undefined> = process.env,
  osLocale: string | undefined = Intl.DateTimeFormat().resolvedOptions().locale,
): Lang | undefined {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name]?.trim();
    if (!value || value === 'C' || value === 'POSIX' || value.startsWith('C.')) continue;
    // The first variable set decides, even for a language we do not have.
    return normalizeLang(value);
  }
  return normalizeLang(osLocale);
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** Messages of the current language. */
export function t(): Messages {
  return LANGUAGES[current];
}

/** Display label of a theme in the current language, falling back to the catalog label. */
export function themeLabel(theme: Theme): string {
  return t().themes[theme.id] ?? theme.label;
}

/** Every label a theme is known by, in any language: used to resolve `--theme`. */
export function themeAliases(theme: Theme): string[] {
  return [theme.id, theme.label, ...Object.values(LANGUAGES).map((m) => m.themes[theme.id]).filter((l): l is string => !!l)];
}

export function locale(): string {
  return LOCALES[current];
}

/** Locale-aware number formatting (`71,571` / `71 571`). */
export function formatNumber(n: number): string {
  return n.toLocaleString(locale());
}

/** Value of `-l fr`, `-l=fr`, `--lang fr` or `--lang=fr`, ignoring anything after `--`. */
export function langFlag(argv: string[]): string | undefined {
  const end = argv.indexOf('--');
  const args = end < 0 ? argv : argv.slice(0, end);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-l' || a === '--lang') return args[i + 1] ?? '';
    const m = /^(?:-l|--lang)=(.*)$/.exec(a);
    if (m) return m[1];
  }
  return undefined;
}
