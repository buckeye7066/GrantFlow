import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AnyaLogEntry, AnyaStatus } from '../api/anya'
import { fetchLogs, fetchStatus, triggerAction } from '../api/anya'

const TOKEN_STORAGE_KEY = 'grantflow:admin-token'

type AdminContextValue = {
  isAdmin: boolean
  status: AnyaStatus | null
  logs: AnyaLogEntry[]
  loading: boolean
  error: string | null
  login: (token: string) => Promise<void>
  logout: () => void
  refreshStatus: () => Promise<void>
  refreshLogs: (limit?: number) => Promise<void>
  execute: (action: 'scan' | 'crawl' | 'explain', payload?: Record<string, unknown>) => Promise<void>
  token: string | null
}

const AdminContext = createContext<AdminContextValue | undefined>(undefined)

export function AdminProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [status, setStatus] = useState<AnyaStatus | null>(null)
  const [logs, setLogs] = useState<AnyaLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const persistToken = useCallback((value: string | null) => {
    if (typeof window === 'undefined') return
    if (value) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value)
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    if (!token) return
    try {
      const next = await fetchStatus({ token })
      setStatus(next)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to fetch Anya status'
      setError(message)
    }
  }, [token])

  const refreshLogs = useCallback(
    async (limit = 25) => {
      if (!token) return
      try {
        const entries = await fetchLogs(limit, { token })
        setLogs(entries)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to fetch Anya logs'
        setError(message)
      }
    },
    [token],
  )

  const login = useCallback(async (candidateToken: string) => {
    setLoading(true)
    try {
      const statusResponse = await fetchStatus({ token: candidateToken })
      const entries = await fetchLogs(25, { token: candidateToken })
      setToken(candidateToken)
      setStatus(statusResponse)
      setLogs(entries)
      setError(null)
      persistToken(candidateToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      setError(message)
      persistToken(null)
      throw err
    } finally {
      setLoading(false)
    }
  }, [persistToken])

  const logout = useCallback(() => {
    setToken(null)
    setStatus(null)
    setLogs([])
    setError(null)
    persistToken(null)
  }, [persistToken])

  const execute = useCallback(
    async (action: 'scan' | 'crawl' | 'explain', payload: Record<string, unknown> = {}) => {
      if (!token) throw new Error('Admin authentication required')
      setLoading(true)
      try {
        await triggerAction(action, payload, { token })
        await Promise.all([refreshStatus(), refreshLogs(25)])
        setError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Action failed'
        setError(message)
        throw err
      } finally {
        setLoading(false)
      }
    },
    [token, refreshStatus, refreshLogs],
  )

  useEffect(() => {
    if (!token) return
    const interval = window.setInterval(() => {
      void refreshStatus()
      void refreshLogs(25)
    }, 10_000)
    return () => window.clearInterval(interval)
  }, [token, refreshStatus, refreshLogs])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (!stored) return
    void (async () => {
      setLoading(true)
      try {
        const statusResponse = await fetchStatus({ token: stored })
        const entries = await fetchLogs(25, { token: stored })
        setToken(stored)
        setStatus(statusResponse)
        setLogs(entries)
        setError(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Authentication failed'
        setError(message)
        persistToken(null)
        setToken(null)
      } finally {
        setLoading(false)
      }
    })()
  }, [persistToken])

  const value = useMemo<AdminContextValue>(
    () => ({
      isAdmin: Boolean(token),
      status,
      logs,
      loading,
      error,
      login,
      logout,
      refreshStatus,
      refreshLogs,
      execute,
      token,
    }),
    [token, status, logs, loading, error, login, logout, refreshStatus, refreshLogs, execute],
  )

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export function useAdmin() {
  const ctx = useContext(AdminContext)
  if (!ctx) {
    throw new Error('useAdmin must be used within an AdminProvider')
  }
  return ctx
}
