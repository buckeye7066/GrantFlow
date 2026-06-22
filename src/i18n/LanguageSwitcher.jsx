import React from 'react'
import { Globe } from 'lucide-react'
import { useLanguage } from './languageContext.js'
import { DEFAULT_LANGUAGE } from '../../shared/languages.js'

/**
 * Compact language switcher for the header / settings. Native-script labels so
 * users recognize their language regardless of the current UI language.
 *
 * Coverage honesty: only English (the default) is fully translated end-to-end.
 * The other languages translate the app shell (navigation, breadcrumbs, common
 * actions, Anya onboarding) and AI replies, but the long tail of page bodies
 * still renders in English. We label those options "(partial)" so the picker
 * never promises a fully-translated experience that doesn't exist, and we show
 * a short notice under the picker when a partially-covered language is active.
 */
export function LanguageSwitcher({ className = '', showIcon = true }) {
  const { language, setLanguage, languages, t } = useLanguage()
  const isPartial = (code) => code !== DEFAULT_LANGUAGE
  const partialSuffix = ` (${t('language.partialTag')})`

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label className="inline-flex items-center gap-2 text-sm">
        {showIcon ? <Globe className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" /> : null}
        <span className="sr-only">{t('language.switcher.label')}</span>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          aria-label={t('language.switcher.label')}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-purple-400"
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.nativeName}{isPartial(lang.code) ? partialSuffix : ''}
            </option>
          ))}
        </select>
      </label>
      {isPartial(language) ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('language.partialNotice')}
        </p>
      ) : null}
    </div>
  )
}

export default LanguageSwitcher
