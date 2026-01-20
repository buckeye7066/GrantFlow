/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useMemo, useReducer } from "react"

const STORAGE_KEY = "grantflow:dashboard-preferences:v1"

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
    throw new Error("useDashboardPreferences must be used within DashboardPreferencesProvider")
  }
  return ctx
}
