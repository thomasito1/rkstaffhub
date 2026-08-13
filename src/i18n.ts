import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import es from './locales/es.json'

export const SUPPORTED_LANGUAGES = ['en', 'es'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export const LANGUAGE_STORAGE_KEY = 'rk.language'

/**
 * i18n is non-negotiable from the first component (CLAUDE.md).
 * Every user-facing string goes through t(), and every key exists in BOTH
 * en.json and es.json. `npm run i18n:check` fails the build on drift.
 *
 * Language resolution order:
 *   1. employee.language from Firestore (applied post-login via setLanguage)
 *   2. localStorage (survives reload, works pre-login)
 *   3. browser language
 *   4. 'en'
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      // React already escapes.
      escapeValue: false,
    },
    returnNull: false,
    // Surface missing keys loudly in dev rather than silently rendering the key.
    saveMissing: false,
    missingKeyHandler: import.meta.env.DEV
      ? (_lngs, _ns, key) => {
          console.error(`[i18n] missing key: ${key}`)
        }
      : undefined,
  })

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

/** Locale tag for Intl formatting. Spanish uses es-US conventions (spec §14). */
export function intlLocale(lang: string = i18n.language): string {
  return lang.startsWith('es') ? 'es-US' : 'en-US'
}

export default i18n
