# GrantFlow i18n (multi-language support)

GrantFlow runs in the user's chosen language. The user picks a language as
**Anya's very first onboarding step** (`/start`), and the choice drives both the
UI strings and the AI (Anya, proposal drafting, etc.).

## Supported languages

Defined once in `shared/languages.js` (the single source of truth, shared by
the backend and frontend):

`en` English · `es` Español · `ru` Русский · `fr` Français · `uk` Українська ·
`de` Deutsch · `pt` Português · `hi` हिन्दी · `zh` 中文 (Simplified).

English is the default and the behaviour-preserving path.

## Frontend usage

```jsx
import { useT, useLanguage } from '@/i18n'

function MyComponent() {
  const t = useT()
  const { language, setLanguage } = useLanguage()
  return <button>{t('common.save')}</button>   // → "Save" / "Guardar" / …
}
```

- `t('key')` looks the key up in the active language's dictionary, falling back
  to English, then to the raw key. Supports `{var}` interpolation:
  `t('greeting', { name })`.
- `useLanguage()` exposes `{ language, setLanguage, t, languages }`.
- `<LanguageSwitcher />` is a ready-made dropdown (mounted in the sidebar
  footer in `src/pages/Layout.jsx`).

The `LanguageProvider` is mounted at the app root in `src/main.jsx`. It:
- reads the saved language from `localStorage` (`grantflow:preferred-language`),
- syncs the profile's stored `preferred_language` from the backend on mount,
- persists changes back to both `localStorage` and the profile,
- keeps `document.documentElement.lang` in sync for accessibility.

## Dictionaries

One flat JSON file per language under `src/i18n/locales/<code>.json`. Keys are
dotted (`nav.dashboard`, `common.save`, `anya.onboarding.allSet`). To add a
string: add the key + English text to `en.json`, then translate it in the other
eight files.

## Persistence (backend)

The choice is stored at the **profile** level in the `language_preferences`
profile section: `{ "preferred_language": "es" }`.

- `GET  /api/profiles/:id/preferred-language` → `{ preferred_language }`
- `PUT  /api/profiles/:id/preferred-language`  body `{ preferred_language }`
- The conversational onboarding (`anyaInterviewEngine`) collects it as the first
  question and persists it via the normal section-write on `/complete`.

Backend AI prompts read it via `backend/services/languagePreference.js`
(`getProfilePreferredLanguage`, `buildLanguageDirectiveForProfile`) and inject a
"Respond ONLY in <language>" directive. Wired into: Anya chat
(`anyaOrchestrator`), proposal drafting (`routes/ai.js /generate/proposal`), and
the grant-application approach advisor.

## Coverage status (phased)

Translated **now** (real translations, all 9 languages): top-nav labels, the
core action buttons (Save / Cancel / Next / Skip / Continue, Set up your
profile, Process with Hamilton), the language picker, and Anya's onboarding
copy. The Anya conversation + the major user-facing AI outputs already respond
in the chosen language end-to-end.

**Not yet wrapped:** the long tail of page bodies, dialogs, and form labels.
These still render English until each string is migrated to a `t('key')` call
with entries added across the nine dictionaries. The pattern above is the only
thing needed to extend coverage — no architecture changes. Pipeline,
profile-overview, and Hamilton-card components were intentionally left untouched
here (other design work is in flight on them).
