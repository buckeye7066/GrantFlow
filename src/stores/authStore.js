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
  completeOAuthSession as completeOAuthSessionRequest,
  logout as logoutRequest,
} from '@/api/auth'
import client, { apiFetch } from '@/api/client'
import { toast } from '@/components/ui/use-toast'
import { useFundingResultsStore } from '@/stores/fundingResultsStore'
import { clearAllProfileScopedStorage } from '@/utils/profileScopedStorage'
import { claimPromoTouch } from '@/utils/promoAttribution'

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

// Profile-bound query-key prefixes. Used both to purge outright on profile
// switch and to scope the previous-profile-id eviction so we never collide
// with unrelated numeric query-key segments (page numbers, limits, etc.).
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

function evictProfileQueries(previousProfileId) {
  if (!registeredQueryClient) return
  try {
    if (previousProfileId) {
      const prevId = String(previousProfileId)
      // Scope the previous-profile-id eviction to known profile-bound prefixes
      // so that small numeric ids ('1', '2') never collide with unrelated query
      // keys that contain page numbers, limits, or pagination indices.
      registeredQueryClient.removeQueries({
        predicate: (q) =>
          Array.isArray(q.queryKey) &&
          typeof q.queryKey[0] === 'string' &&
          PROFILE_BOUND_PREFIXES.includes(q.queryKey[0]) &&
          q.queryKey.some((k) => k !== null && k !== undefined && String(k) === prevId),
      })
    }
    // Always purge the profile-bound discovery / matching keys outright so a
    // hard reload after a profile switch never serves a stale cached result.
    registeredQueryClient.removeQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        typeof q.queryKey[0] === 'string' &&
        PROFILE_BOUND_PREFIXES.includes(q.queryKey[0]),
    })
  } catch (err) {
    // Eviction is a best-effort cache-hygiene step. A failure here must not
    // abort the calling auth flow (logout / profile switch), so we log and
    // continue rather than re-throw.
    try { console.warn('[authStore] queryClient eviction failed:', err?.message || err) } catch { /* ignore */ }
  }
}

const ACCESS_EXPIRY_STORAGE_KEY = 'grantflow:access-expiry'
const REFRESH_LEEWAY_MS = 60 * 1000
const FALLBACK_REFRESH_LEEWAY_MS = 5 * 1000
const MAX_TIMEOUT_MS = 2_147_000_000
let refreshTimerId = null

// Guarded localStorage helpers: private-mode / quota-exceeded environments throw
// on setItem/removeItem; those failures must never abort an auth success path.
function safeLocalStorageSet(key, value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch (err) {
    try { console.warn('[authStore] localStorage.setItem failed:', err?.message || err) } catch { /* ignore */ }
  }
}

function safeLocalStorageRemove(key) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch (err) {
    try { console.warn('[authStore] localStorage.removeItem failed:', err?.message || err) } catch { /* ignore */ }
  }
}

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
  if (!Number.isFinite(expiresAtMs)) {
    // Surface invalid expiry values so inconsistent session management is
    // observable rather than silently dropped.
    try { console.warn('[authStore] persistAccessExpiry called with non-finite expiry:', expiresAtMs) } catch { /* ignore */ }
    return
  }
  safeLocalStorageSet(ACCESS_EXPIRY_STORAGE_KEY, String(Math.trunc(expiresAtMs)))
}

function clearAccessExpiry() {
  if (typeof window === 'undefined') return
  safeLocalStorageRemove(ACCESS_EXPIRY_STORAGE_KEY)
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

function handleAutomaticRefreshFailure(error, get) {
  console.warn('Automatic session refresh failed:', error)
  if (error?.status === 401) {
    get().markSessionExpired('Your session expired. Please sign in again.')
    return
  }
  // A network/gateway blip is not evidence that the HttpOnly session is dead.
  // Keep the current in-memory token and make one later timer attempt.
  if (typeof window !== 'undefined') {
    clearRefreshTimer()
    refreshTimerId = window.setTimeout(() => {
      get().refreshSession().catch((retryError) => {
        if (retryError?.status === 401) {
          get().markSessionExpired('Your session expired. Please sign in again.')
        } else {
          console.warn('Deferred session refresh failed:', retryError)
        }
      })
    }, 30_000)
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
    // Log but do not re-throw — this is a non-critical background task.
    console.error('[authStore] Failed to trigger admin crawlers:', error)
  }
}

const initialState = {
  user: null,
  profiles: [],
  activeProfileId: null,
  accessToken: null,
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
  // 'pending' (new signup, interview already done on /start) |
  // 'pending_reinterview' (existing user reset to the new-user experience --
  // video + Anya's gap interview + tour, via an admin bulk operation) |
  // 'completed' | 'skipped' | null (not eligible, e.g. un-reset existing user)
  guidedCycleTourStatus: null,
  // One-time FORCED WELCOME VIDEO gate. `{ id, url, label } | null`. When set,
  // OnboardingSequencer renders it full-screen ABOVE every other first-run
  // branch; the user POSTs consume + we clear it (setForcedWelcomeVideo(null))
  // so the sequencer falls through. null for everyone with no unconsumed forced
  // row → zero behavior change.
  forcedWelcomeVideo: null,
  // PROFILE-COMPLETION GATE summary from the auth/onboarding payload.
  // `{ active, blocked, exempt, profiles:[...], next:{ profile_id, questions:[...], ... } } | null`.
  // While `blocked` is true (non-admins only — admins resolve to inert), the
  // ProfileCompletionGate overlay asks Anya's numbered questions before the
  // user can proceed. null / exempt / not-blocked → nothing renders.
  profileCompletion: null,
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
    // Security migration: credentials from older builds are deleted without
    // reading or adopting them. The HttpOnly cookie bootstrap in App.jsx is now
    // the only persisted-session path.
    safeLocalStorageRemove('grantflow:access-token')
    safeLocalStorageRemove('grantflow:refresh-token')
    const storedActiveProfileId = localStorage.getItem('grantflow:active-profile-id')
    const storedMethod = localStorage.getItem('grantflow:auth-method')
    const hasSeenOnboarding = localStorage.getItem('grantflow:onboarding-complete') === 'true'
    const updates = {}
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
    clearAccessExpiry()
  },

  clearState: ({ broadcast = false } = {}) => {
    const preferredAuthMethod = get().preferredAuthMethod
    const prevProfileId = get().activeProfileId
    clearRefreshTimer()
    clearAccessExpiry()
    client.clearToken({ broadcast })
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
    // NOTE: For non-admins with an already-populated profile list we return the
    // cached list unless force=true. Callers that need authoritative server
    // data (after a deletion, new share, etc.) MUST pass force:true.
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
    if (payload.userId !== undefined && payload.userId !== null) {
      const isAdmin = normalizeUserAdmin({
        isAdmin: payload.isAdmin,
        is_admin: payload.isAdmin,
        role: payload.role,
      })
      // Admin users always use the virtual '__admin__' profile so the sidebar
      // never shows a stale profile ID from the JWT payload.
      const activeProfileId = isAdmin ? '__admin__' : normalizeId(payload.activeProfileId ?? null)
      const accessibleProfileCount = Number(payload.accessibleProfileCount ?? 0) || 0

      // Treat backend has_completed_onboarding as the SOLE authoritative source
      // for a freshly authenticated user. We must NOT fall back to the persisted
      // store flag here, because a different user logging in on the same browser
      // could otherwise inherit the previous user's onboarding state.
      const hasCompletedOnboarding = Boolean(payload.hasCompletedOnboarding)

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
        guidedCycleTourStatus: payload.guidedCycleTourStatus ?? null,
        forcedWelcomeVideo:
          payload.forcedWelcomeVideo ?? payload.user?.forced_welcome_video ?? null,
        profileCompletion:
          payload.profileCompletion ?? payload.user?.profile_completion ?? payload.profile_completion ?? null,
      }))

      // Fire-and-forget: claim a stored PromoPilot promo touch for this user so
      // server-side conversion events can be attributed. Never throws, no-op
      // without a stored touch.
      claimPromoTouch()

      // Always refresh profiles after canonical auth bootstrap.
      // This keeps the sidebar selector accurate (admins should see ALL profiles).
      get()
        .refreshProfiles({ reason: 'auth_bootstrap', force: true })
        .then((refreshedProfiles) => {
          if (isAdmin) return
          // Recompute needsProfileCreation from the authoritative server list.
          const count = Array.isArray(refreshedProfiles) ? refreshedProfiles.length : 0
          set({ needsProfileCreation: count === 0 && !hasCompletedOnboarding })
        })
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

      // Fire-and-forget promo-touch claim (see the userId-shaped branch above).
      claimPromoTouch()

      // Check if this is an admin user
      if (isAdminUser) {
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
      // Use backend has_completed_onboarding (from payload.user) as the SOLE
      // authoritative source for a freshly authenticated user. Do NOT fall back
      // to the persisted store flag — a different user on the same browser could
      // otherwise inherit the previous user's onboarding state.
      const userCompletedOnboarding = Boolean(payload.user?.has_completed_onboarding)
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
        guidedCycleTourStatus: payload.user?.guided_cycle_tour_status ?? null,
        forcedWelcomeVideo:
          payload.user?.forced_welcome_video ?? payload.forcedWelcomeVideo ?? null,
        profileCompletion:
          payload.user?.profile_completion ?? payload.profile_completion ?? payload.profileCompletion ?? null,
        onboardingCompletedAt: payload.user?.onboarding_completed_at ?? null,
        lastSeenManualVersion: Number(payload.user?.last_seen_manual_version ?? 0),
        lastCompletedTourVersion: Number(payload.user?.last_completed_tour_version ?? 0),
        tourDismissedAt: payload.user?.tour_dismissed_at ?? null,
      })

      // If login payload looks sparse, refresh from server so profile dropdown
      // matches reality, then recompute needsProfileCreation from the
      // authoritative refreshed list.
      if (profiles.length <= 1) {
        get()
          .refreshProfiles({ reason: 'post_login_refresh', force: true })
          .then((refreshedProfiles) => {
            const count = Array.isArray(refreshedProfiles) ? refreshedProfiles.length : 0
            set({ needsProfileCreation: count === 0 && !userCompletedOnboarding })
          })
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
      const normalizedProfileId = normalizeId(payload.profile_id ?? null)
      const user = {
        id: normalizedProfileId ?? 'user',
        display_name: payload.full_name ?? 'GrantFlow User',
        is_admin: false,
      }
      const profiles = payload.profiles ?? []
      const userCompletedOnboarding = Boolean(payload.has_completed_onboarding)
      const needsProfileCreation = profiles.length === 0 && !userCompletedOnboarding
      set({
        user,
        profiles,
        activeProfileId: normalizedProfileId,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
        needsProfileCreation,
        hasSeenOnboarding: userCompletedOnboarding,
      })
      return
    }

    // Unknown payload shape: this is NOT a successful authentication. Throw so
    // callers (loginWithPassword etc.) do not present it as a logged-in state.
    const unknownErr = new Error('Authentication response did not contain a recognizable identity payload')
    unknownErr.code = 'AUTH_UNKNOWN_PAYLOAD'
    try { console.warn('[authStore] setAuthenticatedUser received unrecognized payload shape') } catch { /* ignore */ }
    throw unknownErr
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
            handleAutomaticRefreshFailure(error, get)
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
          handleAutomaticRefreshFailure(error, get)
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
    expiresIn,
    accessExpires,
    refreshExpires,
  } = {}) => {
    set({ isLoading: true, error: null })
    try {
      const response = await client.auth.loginWithTokens({ accessToken })

      // Defer all state writes until after the full response is validated.
      if (response) {
        // Access credentials remain memory-only. Refresh rotation is represented
        // solely by the HttpOnly Set-Cookie response.
        const effectiveAccessToken = response.accessToken ?? accessToken
        if (effectiveAccessToken) {
          client.setToken(effectiveAccessToken)
          set({ accessToken: effectiveAccessToken })
        }
        // Prefer server-issued expiry metadata when present.
        const expiryMeta = {
          expiresIn: response.expiresIn ?? expiresIn,
          accessExpires: response.accessExpires ?? accessExpires,
          refreshExpires: response.refreshExpires ?? refreshExpires,
        }
        if (
          expiryMeta.expiresIn !== undefined ||
          expiryMeta.accessExpires !== undefined ||
          expiryMeta.refreshExpires !== undefined
        ) {
          get().scheduleSessionRefresh(expiryMeta)
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

  completeOAuthSession: async (handoff) => {
    set({ isLoading: true, error: null })
    try {
      const response = await completeOAuthSessionRequest(handoff)
      if (!response?.accessToken || !response?.user) {
        throw new Error('OAuth session handoff did not return an authenticated session')
      }
      client.setToken(response.accessToken)
      set({ accessToken: response.accessToken })
      get().setAuthenticatedUser(response)
      get().scheduleSessionRefresh(response)
      return response
    } catch (error) {
      get().clearState()
      throw error
    } finally {
      set({ isLoading: false })
    }
  },

  refreshSession: async () => {
    try {
      // Use client.refreshTokens() so this shares the single-flight refreshPromise
      // with handleUnauthorized(). This prevents a simultaneous timer-based refresh
      // and a 401-triggered refresh from both hitting /api/auth/refresh at the same
      // time (which would invalidate the rotate-on-use refresh token).
      const response = await client.refreshTokens()
      if (!response) {
        get().clearState()
        return null
      }
      if (response?.accessToken) {
        client.setToken(response.accessToken)
        set({ accessToken: response.accessToken })
      }
      // Refresh responses typically carry only token fields. Only update user
      // state when the response actually contains an identity payload; otherwise
      // we'd wipe the current user. setAuthenticatedUser throws on unknown
      // shapes, so guard before calling it.
      const hasIdentityPayload = Boolean(
        response &&
          ((response.userId !== undefined && response.userId !== null) ||
            response.user ||
            response.role === 'admin' ||
            response.role === 'user'),
      )
      if (hasIdentityPayload) {
        get().setAuthenticatedUser(response)
      }
      // Always reschedule based on the new token expiry even when the response
      // lacks user fields, so the session never silently expires without a
      // future refresh queued.
      if (response) {
        get().scheduleSessionRefresh(response)
      }
      return response
    } catch (error) {
      if (error?.status === 401) get().clearState()
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
      await logoutRequest()
    } finally {
      get().clearState({ broadcast: true })
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
    safeLocalStorageSet('grantflow:auth-method', method)
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
    safeLocalStorageSet('grantflow:onboarding-complete', 'true')
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
   * Persist the new guided first-cycle tour's completion state to the backend.
   * @param {'completed'|'skipped'} status
   */
  markGuidedCycleTourStatus: (status) => {
    set({ guidedCycleTourStatus: status })
    apiFetch('/api/auth/onboarding-state', {
      method: 'PATCH',
      body: JSON.stringify({ guided_cycle_tour_status: status }),
    }).catch((err) => console.warn('[authStore] Failed to persist guided cycle tour state:', err))
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

  /**
   * Replace the profile-completion gate summary (or clear it). Called by
   * ProfileCompletionGate after the user finishes answering a profile's
   * required questions, so the overlay stops blocking without waiting for a
   * fresh /me round-trip.
   */
  setProfileCompletion: (summary) => {
    set({ profileCompletion: summary ?? null })
  },

  /**
   * Set/replace the pending one-time forced welcome video, or clear it.
   * ForcedWelcomeVideo calls setForcedWelcomeVideo(null) after the user finishes
   * (and POSTs consume) so OnboardingSequencer falls through to the normal
   * onboarding branches. `clearForcedWelcomeVideo()` is a convenience alias.
   * @param {{ id: string, url: string, label?: string|null }|null} video
   */
  setForcedWelcomeVideo: (video) => {
    set({ forcedWelcomeVideo: video ?? null })
  },

  clearForcedWelcomeVideo: () => {
    set({ forcedWelcomeVideo: null })
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
