/**
 * apiClient.js — thin delegation layer over the canonical client.js singleton.
 *
 * Previously this file contained a second independent ApiClient class that
 * read/wrote the same localStorage token keys as client.js.  When a 401 hit,
 * BOTH clients would race to call /api/auth/refresh.  Because the backend
 * rotates refresh tokens (single-use), the second refresh invalidated the
 * first, causing cascading 401s.
 *
 * Fix: all exports here now delegate to the single client.js singleton so
 * there is exactly ONE in-flight refresh promise and ONE token store.
 */

import client from '@/api/client'

// The singleton — same instance as client.js's default export.
export const apiClient = client

// Primary fetch method used by most callers.
export const apiFetch = (...args) => client.fetch(...args)

// Convenience shims matching the old ApiClient public API.
export const get = (...args) => client.get(...args)
export const post = (...args) => client.post(...args)
export const patch = (...args) => client.patch(...args)
export const del = (...args) => client.delete(...args)

// Token management — delegate to client.js's setToken / getToken names.
export const setAccessToken = (t) => client.setToken(t)
export const getAccessToken = () => client.getToken()
export const clearAccessToken = () => {
  if (typeof client.clearToken === 'function') {
    client.clearToken()
  } else {
    // client.clearToken is not available — log a warning so this gap is caught
    // during development rather than silently leaving stale auth state.
    console.warn('[apiClient] client.clearToken is not a function; token state may be incomplete. Upgrade client.js to expose clearToken().')
    if (typeof client.setToken === 'function') {
      client.setToken(null)
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('grantflow:access-token')
    }
  }
}

export const setRefreshToken = (t) => client.setRefreshToken(t)
export const getRefreshToken = () => client.getRefreshToken()
export const clearRefreshToken = () => {
  if (typeof client.clearRefreshToken === 'function') {
    client.clearRefreshToken()
  } else {
    console.warn('[apiClient] client.clearRefreshToken is not a function; refresh token state may be incomplete. Upgrade client.js to expose clearRefreshToken().')
    if (typeof client.setRefreshToken === 'function') {
      client.setRefreshToken(null)
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('grantflow:refresh-token')
    }
  }
}

export const setActiveProfileId = (id) => client.setActiveProfileId(id)
export const getActiveProfileId = () => client.getActiveProfileId()

// Map the old setUnauthorizedHandler name to client.js's setAuthFailureHandler.
export const setUnauthorizedHandler = (fn) => client.setAuthFailureHandler(fn)

export default client
