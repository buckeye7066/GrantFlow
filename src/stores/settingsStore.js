import { create } from 'zustand'
import { apiFetch } from '@/api/client'
import { toast } from '@/components/ui/use-toast'

const DEFAULT_PREFERENCES = {
  sidebar_position: 'left',
  sidebar_collapsed: false,
  dashboard_layout: 'grid',
  card_density: 'comfortable',
  table_row_density: 'medium',
  theme: 'system',
  accent_color: 'blue',
  sidebar_color_scheme: 'default',
  high_contrast: false,
  default_landing_page: '/Dashboard',
  items_per_page: 25,
  date_format: 'MM/DD/YYYY',
  currency_display: 'USD',
  timezone: 'America/New_York',
  email_notifications: true,
  grant_deadline_reminder_days: 7,
  weekly_digest: true,
  browser_notifications: false,
  font_size: 'medium',
  reduce_motion: false,
  screen_reader_optimized: false,
  custom_preferences: {},
}

function hexToHsl(hex) {
  const raw = String(hex || '').trim()
  const cleaned = raw.startsWith('#') ? raw.slice(1) : raw
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null

  const r = parseInt(cleaned.slice(0, 2), 16) / 255
  const g = parseInt(cleaned.slice(2, 4), 16) / 255
  const b = parseInt(cleaned.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
  }

  const l = (max + min) / 2
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1))

  const sPct = Math.round(s * 100)
  const lPct = Math.round(l * 100)

  // Format expected by shadcn/tailwind CSS variables: "H S% L%"
  return `${h} ${sPct}% ${lPct}%`
}

function relativeLuminanceFromHex(hex) {
  const raw = String(hex || '').trim()
  const cleaned = raw.startsWith('#') ? raw.slice(1) : raw
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null

  const r8 = parseInt(cleaned.slice(0, 2), 16)
  const g8 = parseInt(cleaned.slice(2, 4), 16)
  const b8 = parseInt(cleaned.slice(4, 6), 16)

  const srgbToLinear = (c8) => {
    const c = c8 / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }

  const r = srgbToLinear(r8)
  const g = srgbToLinear(g8)
  const b = srgbToLinear(b8)
  // WCAG relative luminance
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function pickReadableForegroundHex(backgroundHex, { highContrast = false } = {}) {
  const lum = relativeLuminanceFromHex(backgroundHex)
  if (lum === null) return '#ffffff'

  // Prefer strict black/white in high-contrast mode.
  if (highContrast) {
    return lum > 0.35 ? '#0a0a0a' : '#ffffff'
  }

  // Heuristic threshold: brighter accents need dark text, darker accents need white text.
  return lum > 0.55 ? '#0a0a0a' : '#ffffff'
}

export const useSettingsStore = create((set, get) => ({
  preferences: DEFAULT_PREFERENCES,
  isLoading: false,
  error: null,
  isInitialized: false,

  // Fetch preferences from backend
  fetchPreferences: async () => {
    try {
      set({ isLoading: true, error: null })
      const data = await apiFetch('/api/preferences')
      set({ 
        preferences: { ...DEFAULT_PREFERENCES, ...data },
        isLoading: false,
        isInitialized: true 
      })
      get().applyTheme()
    } catch (error) {
      console.error('Failed to fetch preferences:', error)
      set({
        error: error.message,
        isLoading: false,
        isInitialized: true
      })
      // Use defaults silently — no toast needed since app still functions with DEFAULT_PREFERENCES.
    }
  },

  // Update preferences (both local and backend)
  updatePreferences: async (updates) => {
    const currentPrefs = get().preferences
    const newPrefs = { ...currentPrefs, ...updates }
    
    // Optimistically update local state
    set({ preferences: newPrefs })
    get().applyTheme()
    
    try {
      const data = await apiFetch('/api/preferences', {
        method: 'PUT',
        body: JSON.stringify(updates),
      })
      set({ preferences: { ...DEFAULT_PREFERENCES, ...data }, error: null })
    } catch (error) {
      console.error('Failed to update preferences:', error)
      // Revert on error and notify user so they know the change didn't save
      set({ preferences: currentPrefs, error: error.message })
      try {
        toast({
          variant: 'destructive',
          title: 'Settings not saved',
          description: 'Your preference change could not be saved. Please try again.',
        })
      } catch {
        // toast may not be mounted in all contexts
      }
    }
  },

  // Update a single preference
  updatePreference: (key, value) => {
    get().updatePreferences({ [key]: value })
  },

  // Reset to defaults
  resetPreferences: async () => {
    try {
      set({ isLoading: true, error: null })
      const data = await apiFetch('/api/preferences/reset', {
        method: 'POST',
      })
      set({ 
        preferences: { ...DEFAULT_PREFERENCES, ...data },
        isLoading: false 
      })
      get().applyTheme()
    } catch (error) {
      console.error('Failed to reset preferences:', error)
      set({ error: error.message, isLoading: false })
    }
  },

  // Apply theme to document
  applyTheme: () => {
    const { theme, accent_color, font_size, reduce_motion, high_contrast } = get().preferences
    const root = document.documentElement

    // Apply theme
    if (theme === 'dark') {
      root.classList.add('dark')
    } else if (theme === 'light') {
      root.classList.remove('dark')
    } else {
      // System theme
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }

    // Apply accent color - map to valid Tailwind colors
    const colorMap = {
      blue: '#3b82f6',
      purple: '#a855f7',
      green: '#22c55e',
      orange: '#f97316',
      rose: '#f43f5e',
      cyan: '#06b6d4',
      amber: '#f59e0b',
      pink: '#ec4899',
      // ProfileDetail "Customize profile view" uses these names; without them the
      // selection silently fell back to blue.
      emerald: '#10b981',
      violet: '#8b5cf6',
    }
    const accentHex = colorMap[accent_color] || colorMap.blue
    root.style.setProperty('--accent-color', accentHex)

    // Also drive shadcn/tailwind tokens (these are defined as `hsl(var(--primary))` etc).
    // This makes accent color changes visible across buttons, rings, etc.
    const accentHsl = hexToHsl(accentHex)
    if (accentHsl) {
      root.style.setProperty('--primary', accentHsl)
      root.style.setProperty('--ring', accentHsl)
      root.style.setProperty('--sidebar-ring', accentHsl)
    }

    // Ensure button text stays readable against the chosen accent.
    const fgHex = pickReadableForegroundHex(accentHex, { highContrast: high_contrast })
    const fgHsl = hexToHsl(fgHex)
    if (fgHsl) {
      root.style.setProperty('--primary-foreground', fgHsl)
      root.style.setProperty('--sidebar-primary-foreground', fgHsl)
    }

    // Apply font size
    const fontSizeMap = {
      small: '14px',
      medium: '16px',
      large: '18px',
    }
    root.style.setProperty('--base-font-size', fontSizeMap[font_size] || '16px')

    // Apply motion preference
    if (reduce_motion) {
      root.classList.add('reduce-motion')
    } else {
      root.classList.remove('reduce-motion')
    }

    // Apply high contrast
    if (high_contrast) {
      root.classList.add('high-contrast')
    } else {
      root.classList.remove('high-contrast')
    }
  },
}))
