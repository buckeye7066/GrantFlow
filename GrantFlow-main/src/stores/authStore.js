import { create } from 'zustand'
import {
  startEmailSignIn,
  verifyEmailCode,
  startPhoneSignIn,
  verifyPhoneCode,
  refreshSession,
  logout as logoutRequest,
} from '@/api/auth'
import { base44 } from '@/api/base44Client'
import { apiFetch } from '@/api/client'
import { toast } from '@/components/ui/use-toast'

const ACCESS_EXPIRY_STORAGE_KEY = 'grantflow:access-expiry'
const REFRESH_LEEWAY_MS = 60 * 1000
const FALLBACK_REFRESH_LEEWAY_MS = 5 * 1000
const MAX_TIMEOUT_MS = 2_147_000_000
let refreshTimerId = null

function resolveAccessExpiryMs(meta) {
  if (!meta) return null

  const { accessExpires, expiresIn } = meta

  if (accessExpires !== undefined && accessExpires !== null) {
    if (typeof accessExpires === 'number' && Number.isFinite(accessExpires)) {
      return accessExpires > 1e11 ? accessExpires : Date.now() + accessExpires * 1000
    }

    const numericValue = Number(accessExpires)
    if (Number.isFinite(numericValue)) {
      return numericValue > 1e11 ? numericValue : Date.now() + numericValue * 1000
    }

    const parsed = Date.parse(String(accessExpires))
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  if (expiresIn !== undefined && expiresIn !== null) {
    const numeric = Number(expiresIn)
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Date.now() + numeric * 1000
    }
  }

  return null
}

function persistAccessExpiry(expiresAtMs) {
  if (typeof window === 'undefined') return
  if (!Number.isFinite(expiresAtMs)) return
  window.localStorage.setItem(ACCESS_EXPIRY_STORAGE_KEY, String(Math.trunc(expiresAtMs)))
}

function clearAccessExpiry() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(ACCESS_EXPIRY_STORAGE_KEY)
}

function clearRefreshTimer() {
  if (refreshTimerId !== null) {
    if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
      window.clearTimeout(refreshTimerId)
    } else {
      clearTimeout(refreshTimerId)
    }
    refreshTimerId = null
  }
}

const AUTH_METHODS = new Set(['email', 'phone', 'social'])

// Vite env values are typically strings, but be defensive (some tooling can coerce to boolean).
const IS_SMOKE_UI =
  String(import.meta?.env?.VITE_SMOKE_MODE ?? '').toLowerCase() === 'true' ||
  // Playwright can inject a reliable marker before app code runs.
  (typeof globalThis !== 'undefined' && globalThis.__GF_SMOKE__ === true)

// IMPORTANT:
// We do NOT auto-trigger crawlers on admin login by default.
// This was generating failed jobs (e.g. local/scholarship requiring profile context) and polluting diagnostics.
const ENABLE_ADMIN_AUTO_CRAWL =
  !IS_SMOKE_UI &&
  String(import.meta?.env?.VITE_ENABLE_ADMIN_AUTO_CRAWL ?? '').toLowerCase() === 'true'

// Helper function to trigger crawler jobs for admin
async function triggerAdminCrawlers() {
  try {
    if (!ENABLE_ADMIN_AUTO_CRAWL) return

    // If enabled, only queue crawls that do NOT require a profile context.
    // (Profile-scoped crawlers should be run explicitly from the UI with a selected profile.)
    await apiFetch('/api/crawlers/jobs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'comprehensive',
        parameters: { mode: 'national' },
      }),
    })

    toast({
      title: 'Background crawl queued',
      description: 'A comprehensive crawl was queued in the background.',
    })
  } catch (error) {
    console.error('Failed to trigger admin crawlers:', error)
  }
}

const initialState = {
  user: null,
  profiles: [],
  activeProfileId: null,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  sessionExpired: false,
  sessionMessage: null,
  preferredAuthMethod: 'email',
  hasSeenOnboarding: false,
  needsProfileCreation: false,
  onboardingVideoRequested: false,
  profileWizardRequested: false,
}

function normalizeId(value) {
  if (value === null || value === undefined) return null
  const str = String(value).trim()
  if (!str) return null
  if (str.toLowerCase() === 'null') return null
  if (str.toLowerCase() === 'undefined') return null
  return str
}

export const useAuthStore = create((set, get) => ({
  ...initialState,

  hydrateFromStorage: () => {
    if (typeof window === 'undefined') return
    const accessToken = localStorage.getItem('grantflow:access-token')
    const refreshToken = localStorage.getItem('grantflow:refresh-token')
    const storedMethod = localStorage.getItem('grantflow:auth-method')
    const hasSeenOnboarding = localStorage.getItem('grantflow:onboarding-complete') === 'true'
    const storedExpiry = localStorage.getItem(ACCESS_EXPIRY_STORAGE_KEY)
    const updates = {}
    if (accessToken) {
      base44.setToken(accessToken)
      updates.accessToken = accessToken
    }
    if (refreshToken) {
      base44.setRefreshToken?.(refreshToken)
      updates.refreshToken = refreshToken
    }
    if (storedMethod && AUTH_METHODS.has(storedMethod)) {
      updates.preferredAuthMethod = storedMethod
    }
    updates.hasSeenOnboarding = hasSeenOnboarding
    if (Object.keys(updates).length > 0) {
      set((state) => ({ ...state, ...updates }))
    }
    if (storedExpiry) {
      const expiryMs = Number(storedExpiry)
      if (Number.isFinite(expiryMs) && expiryMs > Date.now()) {
        get().scheduleSessionRefresh({ accessExpires: expiryMs })
      } else {
        clearAccessExpiry()
      }
    }
  },

  clearState: () => {
    const preferredAuthMethod = get().preferredAuthMethod
    clearRefreshTimer()
    clearAccessExpiry()
    base44.clearToken()
    set({ ...initialState, preferredAuthMethod })
  },

  setAuthenticatedUser: (payload) => {
    if (!payload) {
      const preferredAuthMethod = get().preferredAuthMethod
      const hasSeenOnboarding = get().hasSeenOnboarding
      set({ ...initialState, preferredAuthMethod, hasSeenOnboarding })
      return
    }

    // Handle standard auth response with user object
    if (payload.user) {
      const user = payload.user

      // Backend returns profiles nested under user (auth/me + auth/email/verify),
      // while some legacy callers may still provide them at the top-level.
      const profiles = Array.isArray(payload.profiles)
        ? payload.profiles
        : (Array.isArray(payload.user?.profiles) ? payload.user.profiles : [])

      const activeProfileId = normalizeId(
        payload.active_profile_id ?? payload.user?.active_profile_id ?? profiles[0]?.id ?? null,
      )
      
      // Check if this is an admin user
      if (user.is_admin) {
        set({
          user,
          profiles,
          activeProfileId,
          isAuthenticated: true,
          error: null,
          sessionExpired: false,
          sessionMessage: null,
          preferredAuthMethod: get().preferredAuthMethod,
          needsProfileCreation: false, // Admins don't need profiles
          hasSeenOnboarding: true, // Skip onboarding for admins
        })
        
        // Trigger crawler jobs asynchronously (fire-and-forget)
        triggerAdminCrawlers().catch(err => {
          console.warn('Failed to trigger admin crawlers:', err)
        })
        
        return
      }
      
      // Regular user
      const needsProfileCreation = profiles.length === 0 && !get().hasSeenOnboarding
      set({
        user,
        profiles,
        activeProfileId,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
        needsProfileCreation,
      })
      return
    }

    // Legacy: Handle old-style payload with role field (for backwards compatibility)
    if (payload.role === 'admin') {
      const user = {
        id: 'admin',
        display_name: payload.full_name ?? 'Administrator',
        primary_email: payload.email ?? null,
        is_admin: true,
      }
      set({
        user,
        profiles: [],
        activeProfileId: null,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
        needsProfileCreation: false, // Admins don't need profiles
        hasSeenOnboarding: true, // Skip onboarding for admins
      })
      
      // Trigger crawler jobs asynchronously (fire-and-forget)
      triggerAdminCrawlers().catch(err => {
        console.warn('Failed to trigger admin crawlers:', err)
      })
      
      return
    }

    if (payload.role === 'user') {
      const user = {
        id: payload.profile_id ?? 'user',
        display_name: payload.full_name ?? 'GrantFlow User',
        is_admin: false,
      }
      const profiles = payload.profiles ?? []
      const needsProfileCreation = profiles.length === 0 && !get().hasSeenOnboarding
      set({
        user,
        profiles,
        activeProfileId: normalizeId(payload.profile_id ?? null),
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
        needsProfileCreation,
      })
    }
  },

  scheduleSessionRefresh: (sessionMeta = {}) => {
    clearRefreshTimer()

    const expiresAtMs = resolveAccessExpiryMs(sessionMeta)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
      set({ accessTokenExpiresAt: null })
      clearAccessExpiry()
      return
    }

    persistAccessExpiry(expiresAtMs)
    set({ accessTokenExpiresAt: expiresAtMs })

    if (typeof window === 'undefined') {
      return
    }

    const msUntilExpiry = expiresAtMs - Date.now()
    if (msUntilExpiry <= 0) {
      refreshTimerId = window.setTimeout(() => {
        get()
          .refreshSession()
          .catch((error) => {
            console.error('Automatic session refresh failed:', error)
            get().markSessionExpired('Your session expired. Please sign in again.')
          })
      }, 0)
      return
    }

    let refreshDelay = msUntilExpiry - REFRESH_LEEWAY_MS
    if (refreshDelay <= 0) {
      refreshDelay = Math.max(0, msUntilExpiry - FALLBACK_REFRESH_LEEWAY_MS)
    }
    refreshDelay = Math.min(refreshDelay, MAX_TIMEOUT_MS)

    refreshTimerId = window.setTimeout(() => {
      get()
        .refreshSession()
        .catch((error) => {
          console.error('Automatic session refresh failed:', error)
          get().markSessionExpired('Your session expired. Please sign in again.')
        })
    }, refreshDelay)
  },

  startEmailSignIn: async (email) => {
    // If a previous session exists (often stale after deploy), clear it before starting a new login
    try {
      base44.clearToken()
      clearRefreshTimer()
      clearAccessExpiry()
      set({
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        sessionExpired: false,
        sessionMessage: null,
        error: null,
      })
    } catch {
      // ignore
    }

    return startEmailSignIn(email)
  },

  verifyEmailCode: async ({ email, code, profileId, verificationToken }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await verifyEmailCode({ email, code, profileId, verificationToken })
      if (result?.accessToken) {
        base44.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        base44.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
      }
      get().setAuthenticatedUser(result)
      if (result) {
        get().scheduleSessionRefresh(result)
      }
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to verify code' })
      throw error
    }
  },

  startPhoneSignIn: async (phone) => {
    // Same as email: clear stale session before starting new login
    try {
      base44.clearToken()
      clearRefreshTimer()
      clearAccessExpiry()
      set({
        accessToken: null,
        refreshToken: null,
        isAuthenticated: false,
        sessionExpired: false,
        sessionMessage: null,
        error: null,
      })
    } catch {
      // ignore
    }

    return startPhoneSignIn(phone)
  },

  verifyPhoneCode: async ({ phone, code, profileId }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await verifyPhoneCode({ phone, code, profileId })
      if (result?.accessToken) {
        base44.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        base44.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
      }
      get().setAuthenticatedUser(result)
      if (result) {
        get().scheduleSessionRefresh(result)
      }
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to verify code' })
      throw error
    }
  },

  loginWithTokens: async ({
    accessToken,
    refreshToken,
    expiresIn,
    accessExpires,
    refreshExpires,
  } = {}) => {
    set({ isLoading: true, error: null })
    try {
      const response = await base44.auth.loginWithTokens({
        accessToken,
        refreshToken,
      })

      if (accessToken) {
        set({ accessToken })
      }
      if (refreshToken) {
        set({ refreshToken })
      }

      if (expiresIn !== undefined || accessExpires !== undefined || refreshExpires !== undefined) {
        get().scheduleSessionRefresh({ expiresIn, accessExpires, refreshExpires })
      }

      if (response) {
        get().setAuthenticatedUser(response)
      }

      set((state) => ({
        ...state,
        isAuthenticated: Boolean(response),
        sessionExpired: false,
        sessionMessage: null,
        error: null,
      }))

      return response
    } catch (error) {
      get().clearState()
      throw error
    } finally {
      set({ isLoading: false })
    }
  },

  refreshSession: async () => {
    const refreshToken = base44.getRefreshToken?.() ?? get().refreshToken
    if (!refreshToken) {
      get().clearState()
      throw new Error('Missing refresh token')
    }
    try {
      const response = await refreshSession(refreshToken)
      if (response?.accessToken) {
        base44.setToken(response.accessToken)
        set({ accessToken: response.accessToken })
      }
      if (response?.refreshToken) {
        base44.setRefreshToken?.(response.refreshToken)
        set({ refreshToken: response.refreshToken })
      }
      get().setAuthenticatedUser(response)
      if (response) {
        get().scheduleSessionRefresh(response)
      }
      return response
    } catch (error) {
      get().clearState()
      throw error
    }
  },

  markSessionExpired: (message) => {
    base44.clearToken()
    clearRefreshTimer()
    clearAccessExpiry()
    set({
      ...initialState,
      sessionExpired: true,
      sessionMessage: message ?? 'Your session expired. Please sign in again.',
      preferredAuthMethod: get().preferredAuthMethod,
    })
  },

  closeSessionExpired: () => {
    set((state) => ({
      ...state,
      sessionExpired: false,
      sessionMessage: null,
    }))
  },

  logout: async () => {
    try {
      const refreshToken = base44.getRefreshToken?.() ?? get().refreshToken
      if (refreshToken) {
        await logoutRequest(refreshToken)
      }
    } finally {
      get().clearState()
    }
  },

  setActiveProfileId: (profileId) => set({ activeProfileId: normalizeId(profileId) }),

  setPreferredAuthMethod: (method) => {
    if (!AUTH_METHODS.has(method)) return
    if (typeof window !== 'undefined') {
      localStorage.setItem('grantflow:auth-method', method)
    }
    set((state) => {
      if (state.preferredAuthMethod === method) {
        return state
      }
      return {
        ...state,
        preferredAuthMethod: method,
      }
    })
  },

  markOnboardingComplete: () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('grantflow:onboarding-complete', 'true')
    }
    set({ hasSeenOnboarding: true })
  },

  setNeedsProfileCreation: (needs) => {
    set({ needsProfileCreation: needs })
  },

  triggerOnboardingVideo: () => {
    set({ onboardingVideoRequested: true })
  },

  triggerProfileWizard: () => {
    set({ profileWizardRequested: true })
  },

  acknowledgeOnboardingVideo: () => {
    set({ onboardingVideoRequested: false })
  },

  acknowledgeProfileWizard: () => {
    set({ profileWizardRequested: false })
  },
}))

base44.setAuthFailureHandler?.((message) => {
  useAuthStore.getState().markSessionExpired(message)
})
