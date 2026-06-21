import React from 'react'
import { Globe } from 'lucide-react'
import { useLanguage } from './languageContext.js'

/**
 * Compact language switcher for the header / settings. Native-script labels so
 * users recognize their language regardless of the current UI language.
 */
export function LanguageSwitcher({ className = '', showIcon = true }) {
  const { language, setLanguage, languages, t } = useLanguage()

  return (
    <label className={`inline-flex items-center gap-2 text-sm ${className}`}>
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
            {lang.nativeName}
          </option>
        ))}
      </select>
    </label>
  )
}

export default LanguageSwitcher
