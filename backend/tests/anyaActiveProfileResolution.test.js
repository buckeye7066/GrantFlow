/**
 * resolveAnyaActiveProfileId — Anya's "which profile am I working on" resolver.
 *
 * 2026-08-23: Anya lost the current profile on a thin page (the Hamilton
 * needs-you / Triage view sends no pageContext.profileId, and an admin has no
 * session-level activeProfileId), so her profile-scoped tools got a null id and
 * reported real profiles as "not found". The chat SESSION's own profile_id is
 * the durable ground truth and is now the backstop.
 */
import { describe, it, expect } from 'vitest'
import { resolveAnyaActiveProfileId } from '../services/anyaOrchestrator.js'

describe('resolveAnyaActiveProfileId — session profile backstop', () => {
  it('prefers the page context profile the user is actively viewing', () => {
    const user = { isAdmin: true, activeProfileId: 'auth-1' }
    expect(resolveAnyaActiveProfileId(user, { profileId: 'page-1' }, 'session-1')).toBe('page-1')
  })

  it('falls back to the session profile when page context and auth carry none (the lost-profile bug)', () => {
    const user = { isAdmin: true, activeProfileId: null }
    expect(resolveAnyaActiveProfileId(user, {}, 'session-1')).toBe('session-1')
    expect(resolveAnyaActiveProfileId(user, null, 'session-1')).toBe('session-1')
  })

  it('still prefers the auth active profile over the session when both exist', () => {
    const user = { activeProfileId: 'auth-1' }
    expect(resolveAnyaActiveProfileId(user, {}, 'session-9')).toBe('auth-1')
  })

  it('returns null only when page, auth, AND session all lack a profile', () => {
    expect(resolveAnyaActiveProfileId({ isAdmin: true }, {}, null)).toBeNull()
    expect(resolveAnyaActiveProfileId({ isAdmin: true }, {}, '')).toBeNull()
  })

  it('a blank session id never overrides a real auth profile', () => {
    expect(resolveAnyaActiveProfileId({ activeProfileId: 'auth-1' }, null, '   ')).toBe('auth-1')
  })
})
