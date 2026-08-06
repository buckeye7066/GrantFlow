/**
 * Anya owner-only tool gate — the hard gate to the configured admin identity.
 */
import { describe, it, expect } from 'vitest'
import { isOwnerCaller, invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'
import { ADMIN_EMAIL } from '../config/constants.js'

const OWNER = ADMIN_EMAIL

describe('isOwnerCaller', () => {
  it('only the owner email passes (case-insensitive); other admins do not', () => {
    expect(isOwnerCaller({ ctx: { email: OWNER } })).toBe(true)
    expect(isOwnerCaller({ ctx: { email: OWNER.toUpperCase() } })).toBe(true)
    expect(isOwnerCaller({ user: { primary_email: OWNER } })).toBe(true)
    expect(isOwnerCaller({ ctx: { email: 'owner@example.invalid', isAdmin: true } })).toBe(false)
    expect(isOwnerCaller({ ctx: { email: 'other-admin@example.com', isAdmin: true } })).toBe(false)
    expect(isOwnerCaller({})).toBe(false)
  })
})

describe('owner-only tools', () => {
  it('are hidden from a non-owner admin tool list but shown to the owner', () => {
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    expect(adminTools).not.toContain('owner.run_agent')
    expect(ownerTools).toContain('owner.run_agent')
    expect(ownerTools).toContain('owner.edit_profile_section')
    expect(ownerTools).toContain('owner.run_crawler')
  })

  it('reject a non-owner ADMIN at invoke time (server-side gate, before the handler runs)', async () => {
    await expect(
      invokeTool('owner.run_crawler', { profileId: 'p1', type: 'comprehensive' }, {
        ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' },
        user: { role: 'admin', email: 'other-admin@example.com' },
      }),
    ).rejects.toThrow(/owner account/i)
  })

  it('reject even an admin with no email', async () => {
    await expect(
      invokeTool('owner.edit_profile_section', { profileId: 'p1', sectionKey: 'basic_information', data: {} }, {
        ctx: { isAdmin: true, userId: 'u3' },
        user: { role: 'admin' },
      }),
    ).rejects.toThrow(/owner account/i)
  })
})
