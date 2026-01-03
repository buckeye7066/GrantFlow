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

const AUTH_METHODS = new Set(['email', 'phone', 'social'])

// Helper function to trigger crawler jobs for admin
async function triggerAdminCrawlers() {
  try {
    const crawlerTypes = ['local', 'scholarship', 'comprehensive']
    const promises = crawlerTypes.map((type) =>
      apiFetch('/api/crawlers/jobs', {
        method: 'POST',
        body: JSON.stringify({
          type,
          profile_id: null, // Admin crawls don't need a profile
          parameters: {},
        }),
      }).catch((err) => {
        console.error(`Failed to queue ${type} crawler:`, err)
        return null
      })
    )
    await Promise.all(promises)
    
    // Show success toast
    toast({
      title: 'Anya is starting automated crawls...',
      description: 'Background crawlers are queued to find funding opportunities.',
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
  isAuthenticated: false,
  isLoading: false,
  error: null,
  sessionExpired: false,
  sessionMessage: null,
  preferredAuthMethod: 'email',
}

export const useAuthStore = create((set, get) => ({
  ...initialState,

  hydrateFromStorage: () => {
    if (typeof window === 'undefined') return
    const accessToken = localStorage.getItem('grantflow:access-token')
    const refreshToken = localStorage.getItem('grantflow:refresh-token')
    const storedMethod = localStorage.getItem('grantflow:auth-method')
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
    if (Object.keys(updates).length > 0) {
      set((state) => ({ ...state, ...updates }))
    }
  },

  clearState: () => {
    const preferredAuthMethod = get().preferredAuthMethod
    base44.clearToken()
    set({ ...initialState, preferredAuthMethod })
  },

  setAuthenticatedUser: (payload) => {
    if (!payload) {
      const preferredAuthMethod = get().preferredAuthMethod
      set({ ...initialState, preferredAuthMethod })
      return
    }

    if (payload.user) {
      const profiles = Array.isArray(payload.profiles) ? payload.profiles : []
      const activeProfileId =
        payload.active_profile_id ?? profiles[0]?.id ?? null
      set({
        user: payload.user,
        profiles,
        activeProfileId,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
      })
      return
    }

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
      })
      
      // Trigger crawler jobs asynchronously (fire-and-forget)
      setTimeout(() => triggerAdminCrawlers(), 100)
      
      return
    }

    if (payload.role === 'user') {
      const user = {
        id: payload.profile_id ?? 'user',
        display_name: payload.full_name ?? 'GrantFlow User',
        is_admin: false,
      }
      set({
        user,
        profiles: payload.profiles ?? [],
        activeProfileId: payload.profile_id ?? null,
        isAuthenticated: true,
        error: null,
        sessionExpired: false,
        sessionMessage: null,
        preferredAuthMethod: get().preferredAuthMethod,
      })
    }
  },

  startEmailSignIn: async (email) => {
    return startEmailSignIn(email)
  },

  verifyEmailCode: async ({ email, code, profileId }) => {
    set({ isLoading: true, error: null })
    try {
      const result = await verifyEmailCode({ email, code, profileId })
      if (result?.accessToken) {
        base44.setToken(result.accessToken)
        set({ accessToken: result.accessToken })
      }
      if (result?.refreshToken) {
        base44.setRefreshToken?.(result.refreshToken)
        set({ refreshToken: result.refreshToken })
      }
      get().setAuthenticatedUser(result)
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to verify code' })
      throw error
    }
  },

  startPhoneSignIn: async (phone) => {
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
      set({ isLoading: false })
      return result
    } catch (error) {
      set({ isLoading: false, error: error?.message ?? 'Unable to verify code' })
      throw error
    }
  },

  loginWithTokens: async ({ accessToken, refreshToken } = {}) => {
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
      return response
    } catch (error) {
      get().clearState()
      throw error
    }
  },

  markSessionExpired: (message) => {
    base44.clearToken()
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

  setActiveProfileId: (profileId) => set({ activeProfileId: profileId }),

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
}))

base44.setAuthFailureHandler?.((message) => {
  useAuthStore.getState().markSessionExpired(message)
})
