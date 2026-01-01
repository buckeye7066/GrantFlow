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
  defaultSort: "match_score",
  layoutStyle: "expanded",
  fontSize: "medium",
  darkMode: false,
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
    case "SET_SORT":
      return { ...state, defaultSort: action.sort }
    case "SET_LAYOUT":
      return { ...state, layoutStyle: action.layout }
    case "SET_FONT":
      return { ...state, fontSize: action.font }
    case "SET_DARK_MODE":
      return { ...state, darkMode: action.enabled }
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
