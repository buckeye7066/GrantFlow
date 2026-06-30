/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useReducer } from "react"

const STORAGE_KEY = "grantflow:dashboard-preferences:v1"

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

function pickReadableForegroundHex(backgroundHex) {
  const lum = relativeLuminanceFromHex(backgroundHex)
  if (lum === null) return '#ffffff'
  return lum > 0.55 ? '#0a0a0a' : '#ffffff'
}

const defaultState = {
  visibleFields: {
    title: true,
    awardAmount: true,
    deadline: true,
    description: true,
    funder: true,
    status: true,
    tags: true,
  },
  widgetVisibility: {
    pipelineStatus: true,
    recentGrants: true,
    milestones: true,
    analytics: true,
    quickActions: true,
    recentDocuments: true,
  },
  widgetOrder: [
    'pipelineStatus',
    'recentGrants',
    'milestones',
    'analytics',
    'quickActions',
    'recentDocuments',
  ],
  defaultSort: "match_score",
  layoutStyle: "expanded",
  layoutColumns: 2,
  fontSize: "medium",
  colorTheme: "blue",
  darkMode: false,
  notificationPreferences: {
    email: true,
    inApp: true,
    deadlines: true,
    newOpportunities: true,
    statusChanges: true,
  },
  dataDensity: 25,
}

const PreferencesContext = createContext(null)

function reducer(state, action) {
  switch (action.type) {
    case "SET_FIELD_VISIBILITY":
      return {
        ...state,
        visibleFields: {
          ...state.visibleFields,
          [action.field]: action.visible,
        },
      }
    case "SET_WIDGET_VISIBILITY":
      return {
        ...state,
        widgetVisibility: {
          ...state.widgetVisibility,
          [action.widget]: action.visible,
        },
      }
    case "SET_WIDGET_ORDER":
      return {
        ...state,
        widgetOrder: action.order,
      }
    case "SET_SORT":
      return { ...state, defaultSort: action.sort }
    case "SET_LAYOUT":
      return { ...state, layoutStyle: action.layout }
    case "SET_LAYOUT_COLUMNS":
      return { ...state, layoutColumns: action.columns }
    case "SET_FONT":
      return { ...state, fontSize: action.font }
    case "SET_COLOR_THEME":
      return { ...state, colorTheme: action.theme }
    case "SET_DARK_MODE":
      return { ...state, darkMode: action.enabled }
    case "SET_NOTIFICATION_PREFERENCE":
      return {
        ...state,
        notificationPreferences: {
          ...state.notificationPreferences,
          [action.key]: action.enabled,
        },
      }
    case "SET_DATA_DENSITY":
      return { ...state, dataDensity: action.density }
    case "RESET":
      return defaultState
    case "HYDRATE":
      return { ...state, ...action.value }
    default:
      return state
  }
}

export function DashboardPreferencesProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, defaultState)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        dispatch({ type: "HYDRATE", value: { ...defaultState, ...parsed } })
      }
    } catch (error) {
      console.error("Failed to load dashboard preferences", error)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (error) {
      console.error("Failed to save dashboard preferences", error)
    }
  }, [state])

  // Apply appearance preferences globally so "Dark Mode" and "Color Theme" actually work.
  // This is intentionally local-only (localStorage) and reversible.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('dark', Boolean(state.darkMode))
    if (import.meta.env.DEV) {
      // Lightweight trace for debugging theme mismatches.
      console.info('[dashboard-preferences] theme applied', { darkMode: Boolean(state.darkMode) })
    }
  }, [state.darkMode])

  useEffect(() => {
    if (typeof document === 'undefined') return

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

    const accentHex = colorMap[state.colorTheme] || colorMap.blue
    const root = document.documentElement
    root.style.setProperty('--accent-color', accentHex)

    const accentHsl = hexToHsl(accentHex)
    if (accentHsl) {
      root.style.setProperty('--primary', accentHsl)
      root.style.setProperty('--ring', accentHsl)
      root.style.setProperty('--sidebar-ring', accentHsl)
    }

    const fgHex = pickReadableForegroundHex(accentHex)
    const fgHsl = hexToHsl(fgHex)
    if (fgHsl) {
      root.style.setProperty('--primary-foreground', fgHsl)
      root.style.setProperty('--sidebar-primary-foreground', fgHsl)
    }

    if (import.meta.env.DEV) {
      console.info('[dashboard-preferences] accent applied', { colorTheme: state.colorTheme, accentHex })
    }
  }, [state.colorTheme])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const fontSizeMap = {
      small: '14px',
      medium: '16px',
      large: '18px',
    }
    document.documentElement.style.setProperty('--base-font-size', fontSizeMap[state.fontSize] || '16px')
  }, [state.fontSize])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  )
}

export function useDashboardPreferences() {
  const ctx = useContext(PreferencesContext)
  if (!ctx) {
    // Return a safe no-op default so components rendered outside the provider
    // (e.g. during route error recovery) don't crash with a TDZ/throw.
    return { state: defaultState, dispatch: () => {} }
  }
  return ctx
}
