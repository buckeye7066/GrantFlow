import { apiFetch } from './client'
import { createLogger } from '@/utils/logger'

const log = createLogger('auth')

export async function checkAccess(email) {
  log.debug('checking email access')
  return apiFetch('/api/auth/access/check', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function startEmailSignIn(email) {
  log.debug('starting email sign in')
  const response = await apiFetch('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  log.debug('email sign in response received')
  return response
}

export async function startPasswordSetup(email) {
  log.debug('starting password setup')
  return apiFetch('/api/auth/password/setup/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function startPasswordReset(email) {
  log.debug('starting password reset')
  return apiFetch('/api/auth/password/reset/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function completePasswordSetup({ token, password }) {
  log.debug('completing password setup')
  return apiFetch('/api/auth/password/setup/complete', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

export async function loginWithPassword({ email, password }) {
  log.debug('password login')
  return apiFetch('/api/auth/password/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function verifyEmailCode({ email, code, profileId, verificationToken }) {
  return apiFetch('/api/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({
      email,
      code,
      ...(verificationToken ? { verification_token: verificationToken } : {}),
      ...(profileId ? { profile_id: profileId } : {}),
    }),
  })
}

export async function startPhoneSignIn(phone) {
  const response = await apiFetch('/api/auth/phone/start', {
    method: 'POST',
    body: JSON.stringify({ phone }),
  })
  return response
}

export async function verifyPhoneCode({ phone, code, profileId }) {
  return apiFetch('/api/auth/phone/verify', {
    method: 'POST',
    body: JSON.stringify({
      phone,
      code,
      ...(profileId ? { profile_id: profileId } : {}),
    }),
  })
}

const cookieAuthHeaders = { 'X-Requested-With': 'XMLHttpRequest' }

export async function refreshSession() {
  return apiFetch('/api/auth/refresh', {
    method: 'POST',
    headers: cookieAuthHeaders,
    body: '{}',
  })
}

export async function completeOAuthSession(handoff) {
  return apiFetch('/api/auth/oauth/complete', {
    method: 'POST',
    headers: cookieAuthHeaders,
    body: JSON.stringify({ handoff }),
  })
}

export async function logout() {
  return apiFetch('/api/auth/logout', {
    method: 'POST',
    headers: cookieAuthHeaders,
    body: '{}',
  })
}
