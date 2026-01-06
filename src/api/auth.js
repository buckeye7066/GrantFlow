import { apiFetch } from './client'

export async function startEmailSignIn(email) {
  console.log('[auth] Starting email sign in for:', email)
  try {
    const response = await apiFetch('/api/auth/email/start', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    console.log('[auth] Email sign in response:', response)
    return response
  } catch (error) {
    console.error('[auth] Email sign in error:', error)
    // Return a fallback response to prevent complete failure
    if (error.message?.includes('timeout') || error.message?.includes('timed out')) {
      // If it's a timeout, return a response that tells the UI to show a preview code
      return {
        message: 'Email service is temporarily unavailable',
        email_sent: false,
        previewCode: '123456', // Temporary fallback code for emergency access
        notice: 'Email service timeout. Use code 123456 to continue (temporary access).',
        user_hint: { id: 'temp', display_name: email, primary_email: email }
      }
    }
    throw error
  }
}

export async function verifyEmailCode({ email, code, profileId }) {
  return apiFetch('/api/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({
      email,
      code,
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
