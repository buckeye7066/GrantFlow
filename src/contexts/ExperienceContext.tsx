import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { differenceInMinutes, formatDistanceToNow } from 'date-fns'

type Theme = 'light' | 'dark'

type ExperienceContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  lastSavedAt: Date | null
  markSaved: () => void
  lastSavedLabel: string
}

const STORAGE_KEY = 'grantflow:theme'

const ExperienceContext = createContext<ExperienceContextValue | undefined>(undefined)

export function ExperienceProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  useEffect(() => {
    if (typeof document !== 'undefined') {
      const classList = document.documentElement.classList
      if (theme === 'dark') {
        classList.add('dark')
      } else {
        classList.remove('dark')
      }
    }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, theme)
    }
  }, [theme])

  useEffect(() => {
    setLastSavedAt(new Date())
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }, [])

  const markSaved = useCallback(() => {
    setLastSavedAt(new Date())
  }, [])

  const lastSavedLabel = useMemo(() => {
    if (!lastSavedAt) return 'Never'
    const minutes = differenceInMinutes(new Date(), lastSavedAt)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    return formatDistanceToNow(lastSavedAt, { addSuffix: true })
  }, [lastSavedAt])

  const value = useMemo<ExperienceContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      lastSavedAt,
      markSaved,
      lastSavedLabel,
    }),
    [lastSavedAt, lastSavedLabel, markSaved, setTheme, theme, toggleTheme],
  )

  return <ExperienceContext.Provider value={value}>{children}</ExperienceContext.Provider>
}

export function useExperience() {
  const context = useContext(ExperienceContext)
  if (!context) {
    throw new Error('useExperience must be used inside ExperienceProvider')
  }
  return context
}

