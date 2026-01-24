import { apiFetch } from './client'
import { createLogger } from '@/utils/logger'

const log = createLogger('auth')

export async function startEmailSignIn(email) {
  log.debug('starting email sign in')
  const response = await apiFetch('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  log.debug('email sign in response received')
  return response
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

export async function refreshSession(refreshToken) {
  return apiFetch('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
  })
}

export async function logout(refreshToken) {
  return apiFetch('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify(
      refreshToken
        ? {
            refreshToken,
          }
        : {},
    ),
  })
}
