import { env } from '@/config/env.js'

// Use relative URLs in production (proxied) to avoid CORS issues.
// In dev mode, use VITE_API_URL or default to same-origin proxy.
const API_URL = env.isDev ? env.apiUrl : ''
const APP_BASE = env.appBase || '/grantflow'

const ACCESS_TOKEN_KEY = 'grantflow:access-token'
const REFRESH_TOKEN_KEY = 'grantflow:refresh-token'
const ACTIVE_PROFILE_ID_KEY = 'grantflow:active-profile-id'

function safeLocalStorageGet(key) {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

function safeLocalStorageRemove(key) {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

class ApiClient {
  constructor() {
    this.baseUrl = API_URL
    this.accessToken = null
    this.refreshToken = null
    this.activeProfileId = null
    this.refreshPromise = null
    this.onUnauthorized = null

    // Hydrate cached active profile id early (helps attach headers before auth store hydrates).
    const stored = safeLocalStorageGet(ACTIVE_PROFILE_ID_KEY)
    this.activeProfileId = stored && String(stored).trim() ? String(stored).trim() : null
  }

  setUnauthorizedHandler(handler) {
    this.onUnauthorized = typeof handler === 'function' ? handler : null
  }

  setAccessToken(token) {
    this.accessToken = token ? String(token) : null
    if (this.accessToken) safeLocalStorageSet(ACCESS_TOKEN_KEY, this.accessToken)
    else safeLocalStorageRemove(ACCESS_TOKEN_KEY)
  }

  getAccessToken() {
    if (this.accessToken) return this.accessToken
    const stored = safeLocalStorageGet(ACCESS_TOKEN_KEY)
    return stored && String(stored).trim() ? String(stored).trim() : null
  }

  clearAccessToken() {
    this.accessToken = null
    safeLocalStorageRemove(ACCESS_TOKEN_KEY)
  }

  setRefreshToken(token) {
    this.refreshToken = token ? String(token) : null
    if (this.refreshToken) safeLocalStorageSet(REFRESH_TOKEN_KEY, this.refreshToken)
    else safeLocalStorageRemove(REFRESH_TOKEN_KEY)
  }

  getRefreshToken() {
    if (this.refreshToken) return this.refreshToken
    const stored = safeLocalStorageGet(REFRESH_TOKEN_KEY)
    return stored && String(stored).trim() ? String(stored).trim() : null
  }

  clearRefreshToken() {
    this.refreshToken = null
    safeLocalStorageRemove(REFRESH_TOKEN_KEY)
  }

  setActiveProfileId(profileId) {
    const normalized = profileId ? String(profileId).trim() : ''
    this.activeProfileId = normalized ? normalized : null
    if (this.activeProfileId) safeLocalStorageSet(ACTIVE_PROFILE_ID_KEY, this.activeProfileId)
    else safeLocalStorageRemove(ACTIVE_PROFILE_ID_KEY)
  }

  getActiveProfileId() {
    if (this.activeProfileId) return this.activeProfileId
    const stored = safeLocalStorageGet(ACTIVE_PROFILE_ID_KEY)
    return stored && String(stored).trim() ? String(stored).trim() : null
  }

  clearAuth() {
    this.accessToken = null
    this.refreshToken = null
    this.refreshPromise = null
    this.activeProfileId = null
    safeLocalStorageRemove(ACCESS_TOKEN_KEY)
    safeLocalStorageRemove(REFRESH_TOKEN_KEY)
    safeLocalStorageRemove(ACTIVE_PROFILE_ID_KEY)
  }

  async refreshAccessTokenOrThrow() {
    const refreshToken = this.getRefreshToken()
    if (!refreshToken) {
      this.clearAuth()
      const err = new Error('Authentication required')
      err.status = 401
      throw err
    }

    // Single-flight refresh.
    if (this.refreshPromise) {
      await this.refreshPromise
      return
    }

    this.refreshPromise = (async () => {
      try {
        const resp = await fetch(`${this.baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ refreshToken }),
        })

        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          const msg = body?.message || body?.error || `Refresh failed (${resp.status})`
          const err = new Error(msg)
          err.status = resp.status
          throw err
        }

        const body = await resp.json()
        if (body?.accessToken) this.setAccessToken(body.accessToken)
        if (body?.refreshToken) this.setRefreshToken(body.refreshToken)
      } finally {
        this.refreshPromise = null
      }
    })()

    await this.refreshPromise
  }

  async apiFetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`
    const method = String(options.method || 'GET').toUpperCase()
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
    const { responseType = null, ...requestOptions } = options || {} // 'blob' | 'arrayBuffer' | 'response'

    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(requestOptions.headers || {}),
    }
    if (isFormData) delete headers['Content-Type']

    const token = this.getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`

    const activeProfileId = this.getActiveProfileId()
    if (activeProfileId) headers['X-Profile-Id'] = headers['X-Profile-Id'] || activeProfileId

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    const attempt = async (isRetry) => {
      const resp = await fetch(url, {
        ...requestOptions,
        method,
        headers,
        credentials: 'include',
        signal: controller.signal,
        cache: method === 'GET' ? 'no-store' : undefined,
      })

      if (resp.status === 401 && !isRetry && !String(path).startsWith('/api/auth/')) {
        await this.refreshAccessTokenOrThrow().catch((err) => {
          this.clearAuth()
          if (this.onUnauthorized) this.onUnauthorized(err?.message || 'Session expired')
          throw err
        })

        // Retry once with updated token header.
        const refreshed = this.getAccessToken()
        if (refreshed) headers.Authorization = `Bearer ${refreshed}`
        return attempt(true)
      }

      if (resp.status === 401 && String(path).startsWith('/api/auth/')) {
        // Surface auth endpoint errors as-is.
        const body = await resp.json().catch(() => ({}))
        const msg = body?.message || body?.error || 'Request failed'
        const err = new Error(msg)
        err.status = resp.status
        err.details = body
        throw err
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        const msg = body?.message || body?.error || 'Request failed'
        const err = new Error(msg)
        err.status = resp.status
        err.details = body
        throw err
      }

      if (resp.status === 204) return null

      if (responseType === 'response') return resp
      if (responseType === 'blob') return await resp.blob()
      if (responseType === 'arrayBuffer') return await resp.arrayBuffer()

      const contentType = resp.headers.get('content-type') || ''
      if (contentType.includes('application/json')) return resp.json()
      return resp.text()
    }

    try {
      const result = await attempt(false)
      clearTimeout(timeoutId)
      return result
    } catch (error) {
      clearTimeout(timeoutId)
      if (error?.name === 'AbortError') {
        const err = new Error('Request timed out. Please try again.')
        err.status = 504
        throw err
      }
      throw error
    }
  }

  get(path) {
    return this.apiFetch(path, { method: 'GET' })
  }
  post(path, body, options = {}) {
    const payload = body instanceof FormData || typeof body === 'string' || body == null ? body : JSON.stringify(body)
    return this.apiFetch(path, { ...options, method: 'POST', body: payload })
  }
  patch(path, body, options = {}) {
    const payload = body instanceof FormData || typeof body === 'string' || body == null ? body : JSON.stringify(body)
    return this.apiFetch(path, { ...options, method: 'PATCH', body: payload })
  }
  delete(path) {
    return this.apiFetch(path, { method: 'DELETE' })
  }

  redirectToLogin() {
    if (typeof window !== 'undefined') {
      window.location.href = `${APP_BASE.replace(/\/$/, '')}/login`
    }
  }
}

export const apiClient = new ApiClient()

// Required exports (helpers)
export const apiFetch = (...args) => apiClient.apiFetch(...args)
export const get = (...args) => apiClient.get(...args)
export const post = (...args) => apiClient.post(...args)
export const patch = (...args) => apiClient.patch(...args)
export const del = (...args) => apiClient.delete(...args)

export const setAccessToken = (t) => apiClient.setAccessToken(t)
export const getAccessToken = () => apiClient.getAccessToken()
export const clearAccessToken = () => apiClient.clearAccessToken()

export const setRefreshToken = (t) => apiClient.setRefreshToken(t)
export const getRefreshToken = () => apiClient.getRefreshToken()
export const clearRefreshToken = () => apiClient.clearRefreshToken()

export const setActiveProfileId = (id) => apiClient.setActiveProfileId(id)
export const getActiveProfileId = () => apiClient.getActiveProfileId()

export const setUnauthorizedHandler = (fn) => apiClient.setUnauthorizedHandler(fn)

export default apiClient

