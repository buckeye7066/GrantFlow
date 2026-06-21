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
import { useFundingResultsStore } from '@/stores/fundingResultsStore'
import { clearAllProfileScopedStorage } from '@/utils/profileScopedStorage'

// Wired up at app boot via registerQueryClient(qc) from src/App.jsx so we can
// evict React-Query cache entries that include the previous profile id when
// the active profile changes. Avoids hard-coupling this store to the qc
// instance / module load order.
let registeredQueryClient = null

/**
 * Register the application's React-Query client so the auth store can purge
 * profile-bound queries on profile switch and logout. Idempotent — last call
 * wins; passing null deregisters.
 */
export function registerQueryClient(qc) {
  registeredQueryClient = qc ?? null
}

function evictProfileQueries(previousProfileId) {
  if (!registeredQueryClient) return
  try {
    if (previousProfileId) {
      registeredQueryClient.removeQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          q.queryKey.some((k) => k !== null && k !== undefined && String(k) === String(previousProfileId)),
      })
    }
    // Always purge the profile-bound discovery / matching keys outright so a
    // hard reload after a profile switch never serves a stale cached result.
    const PROFILE_BOUND_PREFIXES = [
      'discover-catalog',
      'discover-profile',
      'matcher-opportunities',
      'matching-opportunities',
      'smart-matcher',
      'funding-results',
      'reverse-lookup',
      'profile-pipeline',
    ]
    registeredQueryClient.removeQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        typeof q.queryKey[0] === 'string' &&
        PROFILE_BOUND_PREFIXES.includes(q.queryKey[0]),
    })
  } catch (err) {
    try { console.warn('[authStore] queryClient eviction failed:', err?.message || err) } catch { /* ignore */ }
  }
}

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

/** Normalize admin flags from /api/auth/me, JWT payloads, and legacy login shapes. */
export function normalizeUserAdmin(user) {
  if (!user || typeof user !== 'object') return false
  return Boolean(
    user.is_admin === true ||
      user.is_admin === 1 ||
      user.isAdmin === true ||
      user.role === 'admin' ||
      (Array.isArray(user.roles) && user.roles.includes('admin')),
  )
}

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
  if (!ENABLE_ADMIN_AUTO_CRAWL) return

  // Only queue a context-free national crawl when explicitly enabled via env flag.
  // Profile-scoped crawlers must be triggered from the UI with a selected profile
  // so that location, needs, and applicant type are available to the crawler.
  try {
    await apiFetch('/api/crawlers/jobs', {
      method: 'POST',
      body: JSON.stringify({
        type: 'comprehensive',
        parameters: { mode: 'national' },
      }),
    })

    toast({
      title: 'Background crawl queued',
      description: 'A national comprehensive crawl was queued. For profile-matched results, start a crawl from the Profile page.',
    })
  } catch (error) {
    // Log but do not re-throw â this is a non-critical background task.
    console.error('[authStore] Failed to trigger admin crawlers:', error)
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
      // Tentatively mark authenticated so route guards don't briefly redirect
      // returning users (and admin smoke tests) to /login while client.auth.me()
      // is still in flight. App.jsx's bootstrap will call clearState() if the
      // token turns out to be invalid, flipping this back to false.
      updates.isAuthenticated = true
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
    const prevProfileId = get().activeProfileId
    clearRefreshTimer()
    clearAccessExpiry()
    client.clearToken()
    client.setActiveProfileId?.(null)
    // Funding-results store is persisted to localStorage; if we don't clear it
    // on logout / session-expired, the next user (or the same user with a
    // different active profile) sees stale results from the previous session.
    try { useFundingResultsStore.getState().clear() } catch (err) {
      console.warn('[authStore] failed to clear funding results store:', err?.message || err)
    }
    // Drop every profile-scoped localStorage key (matcher checklists, saved
    // grants caches, dismissed suggestions, etc.) so a fresh user never sees
    // the previous user's profile artefacts.
    try { clearAllProfileScopedStorage() } catch (err) {
      console.warn('[authStore] failed to clear profile-scoped storage:', err?.message || err)
    }
    evictProfileQueries(prevProfileId)
    set({ ...initialState, preferredAuthMethod })
  },

  refreshProfiles: async ({ reason = 'manual', force = false } = {}) => {
    const state = get()
    const isAdmin = normalizeUserAdmin(state?.user)
    const prevCount = Array.isArray(state?.profiles) ? state.profiles.length : 0

    if (!state?.isAuthenticated) return []
    if (!force && !isAdmin && prevCount > 0) return state.profiles

    try {
      // Admins should see all profiles; backend will scope automatically for non-admins.
      const url = isAdmin ? '/api/profiles?limit=1000' : '/api/profiles'
      const data = await apiFetch(url)
          // Defence-in-depth: strip deleted profiles so stale cache entries are never visible.
              const profiles = (Array.isArray(data) ? data : []).filter((p) => p?.status !== 'deleted')

      set({ profiles })

      // Safety: if the active profile no longer exists in the accessible list, reset it.
      // '__admin__' is a virtual sentinel and is never in the profiles list — skip it.
      const active = state.activeProfileId
      if (active && active !== '__admin__' && !profiles.some((p) => String(p?.id) === String(active))) {
        const nextActive = isAdmin ? '__admin__' : (profiles[0]?.id ?? null)
        client.setActiveProfileId?.(nextActive)
        set({ activeProfileId: nextActive })
      }

      // Dev-only: this fired on every admin refresh and spammed the production
      // console. Keep it for local debugging, silence it in the shipped build.
      if (import.meta.env?.DEV && isAdmin && (force || profiles.length !== prevCount)) {
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
      const isAdmin = normalizeUserAdmin({
        isAdmin: payload.isAdmin,
        is_admin: payload.isAdmin,
        role: payload.role,
      })
      // Admin users always use the virtual '__admin__' profile so the sidebar
      // never shows a stale profile ID from the JWT payload.
      const activeProfileId = isAdmin ? '__admin__' : normalizeId(payload.activeProfileId ?? null)
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
      const user = {
        ...payload.user,
        is_admin: normalizeUserAdmin(payload.user),
      }

      // Backend returns profiles nested under user (auth/me + auth/email/verify),
      // while some legacy callers may still provide them at the top-level.
      const profiles = Array.isArray(payload.profiles)
        ? payload.profiles
        : (Array.isArray(payload.user?.profiles) ? payload.user.profiles : [])

      const isAdminUser = normalizeUserAdmin(user)
      // Admin users always use the virtual '__admin__' profile so the sidebar
      // never shows a stale profile ID from the login payload.
      const activeProfileId = isAdminUser
        ? '__admin__'
        : normalizeId(
            payload.active_profile_id ?? payload.user?.active_profile_id ?? profiles[0]?.id ?? null,
          )

      client.setActiveProfileId?.(activeProfileId)
      
      // Check if this is an admin user
      if (normalizeUserAdmin(user)) {
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

        // Ensure admins see all profiles (server-backed) but preserve '__admin__' sentinel.
        get()
          .refreshProfiles({ reason: 'admin_login', force: true })
          .then((refreshedProfiles) => {
            const currentActive = get().activeProfileId
            // '__admin__' is virtual — never in the profiles list, so skip the reset check.
            if (
              currentActive &&
              currentActive !== '__admin__' &&
              !refreshedProfiles.some((p) => String(p?.id) === String(currentActive))
            ) {
              // Active profile from login payload no longer valid after full refresh.
              client.setActiveProfileId?.('__admin__')
              set({ activeProfileId: '__admin__' })
            }
          })
          .catch(() => {})
        
        // Trigger crawler jobs asynchronously (fire-and-forget)
        triggerAdminCrawlers().catch(err => {
          console.warn('Failed to trigger admin crawlers:', err)
        })
        
        return
      }
      
      // Regular user
      // Use backend hasCompletedOnboarding (from payload.user if available) as authoritative source,
      // falling back to the store's current hasSeenOnboarding flag.
      const userCompletedOnboarding =
        Boolean(payload.user?.has_completed_onboarding) || get().hasSeenOnboarding
      const needsProfileCreation = profiles.length === 0 && !userCompletedOnboarding
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
        hasSeenOnboarding: userCompletedOnboarding,
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
            console.warn('Automatic session refresh failed:', error)
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
          console.warn('Automatic session refresh failed:', error)
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
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:access-token', result.accessToken)
        }
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:refresh-token', result.refreshToken)
        }
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
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:access-token', result.accessToken)
        }
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:refresh-token', result.refreshToken)
        }
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
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:access-token', result.accessToken)
        }
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:refresh-token', result.refreshToken)
        }
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
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:access-token', result.accessToken)
        }
      }
      if (result?.refreshToken) {
        client.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
        if (typeof window !== 'undefined') {
          localStorage.setItem('grantflow:refresh-token', result.refreshToken)
        }
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

      // Defer all state writes until after the full response is validated.
      if (response) {
        if (accessToken) {
          client.setToken(accessToken)
          set({ accessToken })
          if (typeof window !== 'undefined') {
            localStorage.setItem('grantflow:access-token', accessToken)
          }
        }
        if (refreshToken) {
          client.setRefreshToken?.(refreshToken)
          set({ refreshToken })
          if (typeof window !== 'undefined') {
            localStorage.setItem('grantflow:refresh-token', refreshToken)
          }
        }
        if (expiresIn !== undefined || accessExpires !== undefined || refreshExpires !== undefined) {
          get().scheduleSessionRefresh({ expiresIn, accessExpires, refreshExpires })
        }
        get().setAuthenticatedUser(response)
        set((state) => ({
          ...state,
          isAuthenticated: true,
          sessionExpired: false,
          sessionMessage: null,
          error: null,
        }))
      }

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
    const prev = get().activeProfileId
    client.setActiveProfileId?.(normalized)
    set({ activeProfileId: normalized })
    // Persist immediately so onRehydrateStorage callbacks (fundingResultsStore,
    // saved grants, etc.) can compare against the canonical active id without
    // racing the auth store's own persistence.
    try {
      if (typeof window !== 'undefined') {
        if (normalized) {
          window.localStorage.setItem('grantflow:active-profile-id', String(normalized))
        } else {
          window.localStorage.removeItem('grantflow:active-profile-id')
        }
      }
    } catch { /* ignore storage errors */ }

    const profileActuallyChanged =
      prev !== null && prev !== undefined &&
      normalized !== null && normalized !== undefined &&
      String(prev) !== String(normalized)
    if (profileActuallyChanged) {
      try { useFundingResultsStore.getState().clear() } catch (err) {
        console.warn('[authStore] failed to clear funding results on profile switch:', err?.message || err)
      }
      try { clearAllProfileScopedStorage() } catch (err) {
        console.warn('[authStore] failed to clear profile-scoped storage on profile switch:', err?.message || err)
      }
      evictProfileQueries(prev)
      // Saved-grants are profile-scoped server-side (RC-14). Re-fetch from
      // the backend with the new X-Profile-Id so the client cache reflects
      // this profile's saves rather than the previous profile's.
      try {
        // Lazy import: savedGrantsStore lives in the same dir but importing it
        // statically would create a cycle (it imports the api client which
        // ultimately reads from authStore). Resolve via dynamic import.
        import('./savedGrantsStore.js')
          .then(({ useSavedGrantsStore }) => {
            useSavedGrantsStore.getState().resyncForProfile?.()
          })
          .catch(() => {})
      } catch { /* ignore */ }
    }
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

/**
 * Canonical active-profile-id selector. Use this hook in every page / component
 * that depends on the active profile so reads stay in lock-step with
 * authStore.setActiveProfileId(). Don't keep parallel local profile-id state.
 */
export function useActiveProfileId() {
  return useAuthStore((state) => state.activeProfileId)
}
