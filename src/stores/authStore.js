import { create } from 'zustand'
import {
  startEmailSignIn,
  startPasswordSetup,
  startPasswordReset,
  completePasswordSetup,
  loginWithPassword,
  verifyEmailCode,
  startPhoneSignIn,
  verifyPhoneCode,
  refreshSession,
  logout as logoutRequest,
} from '@/api/auth'
import client, { apiFetch } from '@/api/client'
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
  // Backend-persisted onboarding/tour state (from GET /api/auth/me)
  hasCompletedOnboarding: false,
  onboardingCompletedAt: null,
  lastSeenManualVersion: 0,
  lastCompletedTourVersion: 0,
  tourDismissedAt: null,
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
    const storedActiveProfileId = localStorage.getItem('grantflow:active-profile-id')
    const storedMethod = localStorage.getItem('grantflow:auth-method')
    const hasSeenOnboarding = localStorage.getItem('grantflow:onboarding-complete') === 'true'
    const storedExpiry = localStorage.getItem(ACCESS_EXPIRY_STORAGE_KEY)
    const updates = {}
    if (accessToken) {
      client.setToken(accessToken)
      updates.accessToken = accessToken
    }
    if (refreshToken) {
      client.setRefreshToken?.(refreshToken)
      updates.refreshToken = refreshToken
    }
    if (storedActiveProfileId) {
      client.setActiveProfileId?.(storedActiveProfileId)
      updates.activeProfileId = normalizeId(storedActiveProfileId)
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
    client.clearToken()
    client.setActiveProfileId?.(null)
    set({ ...initialState, preferredAuthMethod })
  },

  refreshProfiles: async ({ reason = 'manual', force = false } = {}) => {
    const state = get()
    const isAdmin = Boolean(state?.user?.is_admin)
    const prevCount = Array.isArray(state?.profiles) ? state.profiles.length : 0

    if (!state?.isAuthenticated) return []
    if (!force && !isAdmin && prevCount > 0) return state.profiles

    try {
      // Admins should see all profiles; backend will scope automatically for non-admins.
      const url = isAdmin ? '/api/profiles?limit=1000' : '/api/profiles'
      const data = await apiFetch(url)
      const profiles = Array.isArray(data) ? data : []

      set({ profiles })

      // Safety: if the active profile no longer exists in the accessible list, reset it.
      const active = state.activeProfileId
      if (active && !profiles.some((p) => String(p?.id) === String(active))) {
        const nextActive = isAdmin ? null : (profiles[0]?.id ?? null)
        client.setActiveProfileId?.(nextActive)
        set({ activeProfileId: nextActive })
      }

      if (isAdmin && (force || profiles.length !== prevCount)) {
        console.info('[authStore] refreshed profiles', {
          reason,
          previous_count: prevCount,
          count: profiles.length,
        })
      }

      return profiles
    } catch (error) {
      console.warn('[authStore] failed to refresh profiles', {
        reason,
        error: error?.message || String(error),
      })
      return Array.isArray(state?.profiles) ? state.profiles : []
    }
  },

  setAuthenticatedUser: (payload) => {
    if (!payload) {
      const preferredAuthMethod = get().preferredAuthMethod
      const hasSeenOnboarding = get().hasSeenOnboarding
      set({ ...initialState, preferredAuthMethod, hasSeenOnboarding })
      return
    }

    // Canonical auth bootstrap (`GET /api/auth/me`) shape:
    // { userId, email, isAdmin, activeProfileId, accessibleProfileCount, accessibleOrgCount,
    //   hasCompletedOnboarding, onboardingCompletedAt, lastSeenManualVersion,
    //   lastCompletedTourVersion, tourDismissedAt }
    if (payload.userId) {
      const activeProfileId = normalizeId(payload.activeProfileId ?? null)
      const isAdmin = Boolean(payload.isAdmin)
      const accessibleProfileCount = Number(payload.accessibleProfileCount ?? 0) || 0

      // Use backend has_completed_onboarding as the authoritative source.
      // Fall back to localStorage for backward-compat during rollout of migration 047.
      // TODO: Remove localStorage fallback once all users have migrated (> 30 days post-deploy).
      const backendCompleted = Boolean(payload.hasCompletedOnboarding)
      const localCompleted = typeof window !== 'undefined'
        ? localStorage.getItem('grantflow:onboarding-complete') === 'true'
        : false
      const hasCompletedOnboarding = backendCompleted || localCompleted

      const needsProfileCreation =
        !isAdmin && accessibleProfileCount === 0 && !hasCompletedOnboarding

      const user = {
        id: payload.userId,
        primary_email: payload.email ?? null,
        email: payload.email ?? null,
        is_admin: isAdmin,
      }

      client.setActiveProfileId?.(activeProfileId)

      set((state) => ({
        ...state,
        user,
        activeProfileId,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        needsProfileCreation,
        // Onboarding/tour state from backend
        hasSeenOnboarding: hasCompletedOnboarding,
        hasCompletedOnboarding,
        onboardingCompletedAt: payload.onboardingCompletedAt ?? null,
        lastSeenManualVersion: Number(payload.lastSeenManualVersion ?? 0),
        lastCompletedTourVersion: Number(payload.lastCompletedTourVersion ?? 0),
        tourDismissedAt: payload.tourDismissedAt ?? null,
      }))

      // Always refresh profiles after canonical auth bootstrap.
      // This keeps the sidebar selector accurate (admins should see ALL profiles).
      get()
        .refreshProfiles({ reason: 'auth_bootstrap', force: isAdmin })
        .catch(() => {})
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

      client.setActiveProfileId?.(activeProfileId)
      
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

        // Ensure admins see all profiles (server-backed).
        get()
          .refreshProfiles({ reason: 'admin_login', force: true })
          .catch(() => {})
        
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

      // If login payload looks sparse, refresh from server so profile dropdown matches reality.
      if (profiles.length <= 1) {
        get()
          .refreshProfiles({ reason: 'post_login_refresh', force: false })
          .catch(() => {})
      }
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

      // Legacy admin payload: still hydrate the full profile list for the sidebar selector.
      get()
        .refreshProfiles({ reason: 'legacy_admin_login', force: true })
        .catch(() => {})
      
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
      client.clearToken()
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

  startPasswordSetup: async (email) => {
    // Clear any stale session before beginning auth.
    try {
      client.clearToken()
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
    return startPasswordSetup(email)
  },

  startPasswordReset: async (email) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!normalizedEmail) {
      const err = new Error('email is required')
      err.status = 400
      throw err
    }

    const response = await startPasswordReset(normalizedEmail)
    return response
  },

  loginWithPassword: async ({ email, password }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await loginWithPassword({ email, password })
      if (result?.accessToken) {
        client.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
      }
      get().setAuthenticatedUser(result)
      if (result) {
        get().scheduleSessionRefresh(result)
      }
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to sign in' })
      throw error
    }
  },

  completePasswordSetup: async ({ token, password }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await completePasswordSetup({ token, password })
      if (result?.accessToken) {
        client.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
      }
      get().setAuthenticatedUser(result)
      if (result) {
        get().scheduleSessionRefresh(result)
      }
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to set password' })
      throw error
    }
  },

  verifyEmailCode: async ({ email, code, profileId, verificationToken }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await verifyEmailCode({ email, code, profileId, verificationToken })
      if (result?.accessToken) {
        client.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
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
      client.clearToken()
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
        client.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
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
      const response = await client.auth.loginWithTokens({
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
    const refreshToken = client.getRefreshToken?.() ?? get().refreshToken
    if (!refreshToken) {
      get().clearState()
      throw new Error('Missing refresh token')
    }
    try {
      // Use client.refreshTokens() so this shares the single-flight refreshPromise
      // with handleUnauthorized(). This prevents a simultaneous timer-based refresh
      // and a 401-triggered refresh from both hitting /api/auth/refresh at the same
      // time (which would invalidate the rotate-on-use refresh token).
      const response = await client.refreshTokens()
      if (response?.accessToken) {
        client.setToken(response.accessToken)
        set({ accessToken: response.accessToken })
      }
      if (response?.refreshToken) {
        client.setRefreshToken?.(response.refreshToken)
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
    client.clearToken()
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
      const refreshToken = client.getRefreshToken?.() ?? get().refreshToken
      if (refreshToken) {
        await logoutRequest(refreshToken)
      }
    } finally {
      get().clearState()
    }
  },

  setActiveProfileId: (profileId) => {
    const normalized = normalizeId(profileId)
    client.setActiveProfileId?.(normalized)
    set({ activeProfileId: normalized })
  },

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
    set({ hasSeenOnboarding: true, hasCompletedOnboarding: true, onboardingCompletedAt: new Date().toISOString() })
    // Persist to backend (fire-and-forget; localStorage is still the fallback)
    apiFetch('/api/auth/onboarding-state', {
      method: 'PATCH',
      body: JSON.stringify({ has_completed_onboarding: true }),
    }).catch((err) => console.warn('[authStore] Failed to persist onboarding state:', err))
  },

  /**
   * Persist tour completion state to the backend.
   * @param {number} version - The tour version that was completed.
   */
  markTourComplete: (version) => {
    const now = new Date().toISOString()
    set({ lastCompletedTourVersion: version, tourDismissedAt: now })
    apiFetch('/api/auth/onboarding-state', {
      method: 'PATCH',
      body: JSON.stringify({ last_completed_tour_version: version, tour_dismissed_at: now }),
    }).catch((err) => console.warn('[authStore] Failed to persist tour state:', err))
  },

  /**
   * Persist manual version seen to the backend.
   * @param {number} version - The manual version that was viewed.
   */
  markManualSeen: (version) => {
    set({ lastSeenManualVersion: version })
    apiFetch('/api/auth/onboarding-state', {
      method: 'PATCH',
      body: JSON.stringify({ last_seen_manual_version: version }),
    }).catch((err) => console.warn('[authStore] Failed to persist manual version:', err))
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

client.setAuthFailureHandler?.((message) => {
  useAuthStore.getState().markSessionExpired(message)
})
