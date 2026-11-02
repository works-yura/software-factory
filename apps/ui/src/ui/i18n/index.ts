import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

/**
 * UI translations. Catalogs live in `locales/<language>/<namespace>.json`; English
 * is the source of truth and the fallback, so a key missing from another
 * language shows the English text instead of the key.
 */

export const SUPPORTED_LANGUAGES = ['en', 'uk'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', uk: 'Українська' };

/** Where the chosen language is remembered across visits. */
export const LANGUAGE_STORAGE_KEY = 'factory.language';

const catalogs = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json', { eager: true });

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, module] of Object.entries(catalogs)) {
  const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match) continue;
  const [, language, namespace] = match as unknown as [string, string, string];
  (resources[language] ??= {})[namespace] = module.default;
}

export const NAMESPACES = Object.keys(resources.en ?? {});

// Test suites assert English copy; never let the runner's locale leak in.
const underTest = import.meta.env.MODE === 'test';

if (!i18next.isInitialized) {
  const instance = underTest ? i18next : i18next.use(LanguageDetector);
  void instance.use(initReactI18next).init({
    resources,
    ns: NAMESPACES,
    defaultNS: 'common',
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    nonExplicitSupportedLngs: true,
    ...(underTest ? { lng: 'en' } : {}),
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
    react: { useSuspense: false },
  });

  const syncDocumentLanguage = (language: string) => {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  };
  syncDocumentLanguage(i18next.resolvedLanguage ?? 'en');
  i18next.on('languageChanged', syncDocumentLanguage);
}

export const i18n = i18next;

// @mastra/playground-ui (vendored in packages/playground-ui) ships English labels and routes each one
// through `libText()`, which calls `globalThis.__factoryLibT`. Catalogs are keyed by the English text.
const libraryCatalogs = import.meta.glob<{ default: Record<string, string> }>('./library/*.json', { eager: true });
const libraryText: Record<string, Record<string, string>> = {};
for (const [path, module] of Object.entries(libraryCatalogs)) {
  const language = /\.\/library\/([^/]+)\.json$/.exec(path)?.[1];
  if (language) libraryText[language] = module.default;
}
(globalThis as { __factoryLibT?: (text: string) => string }).__factoryLibT = text =>
  libraryText[currentLanguage()]?.[text] ?? text;

/** The supported language currently in use. */
export function currentLanguage(): Language {
  const resolved = i18next.resolvedLanguage ?? i18next.language;
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(resolved) ? (resolved as Language) : 'en';
}
