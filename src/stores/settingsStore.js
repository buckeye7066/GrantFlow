import { create } from 'zustand'
import { apiFetch } from '@/api/client'

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
      // Revert on error
      set({ preferences: currentPrefs, error: error.message })
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
    }
    root.style.setProperty('--accent-color', colorMap[accent_color] || colorMap.blue)

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
