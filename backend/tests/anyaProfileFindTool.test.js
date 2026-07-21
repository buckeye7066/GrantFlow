/**
 * Anya `profile.find` — resolve a profile by NAME so Anya never asks the user
 * for a profile ID (the "what's Robert's profile ID?" defect).
 *
 * Verifies: tenancy scoping happens IN the query (non-admins search only their
 * accessible ids; a name collision can never leak another tenant's profile),
 * admins search everything EXCEPT Amy synthetics, the single-match guidance
 * tells Anya to proceed without re-asking, and the tool is chat-whitelisted.
 */

import { describe, expect, it } from 'vitest'
import { invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'
import { CHAT_TOOL_WHITELIST } from '../services/anyaOrchestrator.js'

// DB stub: captures the profile-search SQL + params and returns `rows`.
// Unknown statements (usage logging etc.) get inert defaults.
function makeDb(rows) {
  const captured = { sql: null, params: null }
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from profiles') && norm.includes('like')) {
        return {
          all: (...params) => {
            captured.sql = norm
            captured.params = params
            return rows
          },
        }
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
  return { db, captured }
}

const ROBERT = { id: 'p-robert', display_name: 'Robert Wilson', primary_type: 'individual', state: 'TN', status: 'active' }

describe('profile.find scoping', () => {
  it('non-admin: search universe IS the accessible id set (predicate in the query)', async () => {
    const { db, captured } = makeDb([ROBERT])
    const ctx = { userId: 'u1', isAdmin: false, accessibleProfileIds: new Set(['p-robert', 'p-self']) }
    const res = await invokeTool('profile.find', { query: 'robert' }, { db, ctx })
    expect(captured.sql).toContain('id in (')
    // Both accessible ids are bound ahead of the LIKE needle — nothing else.
    expect(captured.params.slice(0, 2).sort()).toEqual(['p-robert', 'p-self'])
    expect(captured.params).toContain('%robert%')
    expect(res.output.count).toBe(1)
    expect(res.output.matches[0]).toMatchObject({ id: 'p-robert', name: 'Robert Wilson' })
  })

  it('non-admin with an EMPTY accessible set gets zero matches and never queries', async () => {
    const { db, captured } = makeDb([ROBERT])
    const ctx = { userId: 'u1', isAdmin: false, accessibleProfileIds: new Set() }
    const res = await invokeTool('profile.find', { query: 'robert' }, { db, ctx })
    expect(captured.sql).toBeNull()
    expect(res.output.count).toBe(0)
  })

  it('admin: searches all profiles but EXCLUDES Amy synthetic training profiles', async () => {
    const { db, captured } = makeDb([ROBERT])
    const ctx = { userId: 'owner', isAdmin: true, accessibleProfileIds: null }
    const res = await invokeTool('profile.find', { query: 'Robert' }, { db, ctx })
    expect(captured.sql).not.toContain('id in (')
    expect(captured.sql).toContain("coalesce(created_by, '') != 'agent:amy'")
    expect(captured.params).toContain('%robert%')
    expect(res.output.count).toBe(1)
  })

  it('rejects an unauthenticated caller', async () => {
    const { db } = makeDb([ROBERT])
    await expect(invokeTool('profile.find', { query: 'robert' }, { db, ctx: {} })).rejects.toThrow(/not authorized/i)
  })

  it('requires a query', async () => {
    const { db } = makeDb([])
    const ctx = { userId: 'u1', isAdmin: true }
    // The registry's schema validator rejects a blank required param before the
    // handler runs; either message is the same correct behavior.
    await expect(invokeTool('profile.find', { query: '   ' }, { db, ctx })).rejects.toThrow(/query/i)
  })
})

describe('profile.find guidance', () => {
  it('a single match tells Anya to USE the id now, not re-ask the user', async () => {
    const { db } = makeDb([ROBERT])
    const res = await invokeTool('profile.find', { query: 'robert' }, { db, ctx: { userId: 'owner', isAdmin: true } })
    expect(res.output.guidance).toMatch(/use this id/i)
    expect(res.output.guidance).toMatch(/do not ask the user/i)
  })

  it('multiple matches tell Anya to disambiguate by NAME, never by id', async () => {
    const twin = { ...ROBERT, id: 'p-robert-2', display_name: 'Robert Smith' }
    const { db } = makeDb([ROBERT, twin])
    const res = await invokeTool('profile.find', { query: 'robert' }, { db, ctx: { userId: 'owner', isAdmin: true } })
    expect(res.output.count).toBe(2)
    expect(res.output.guidance).toMatch(/by name/i)
  })
})

describe('chat wiring', () => {
  it('profile.find and chat.setAppearance are chat-whitelisted AND registered', () => {
    expect(CHAT_TOOL_WHITELIST).toContain('profile.find')
    expect(CHAT_TOOL_WHITELIST).toContain('chat.setAppearance')
    const registered = listToolMetadata({ isAdmin: false, userId: 'u1' }).map((t) => t.name)
    for (const name of CHAT_TOOL_WHITELIST) {
      expect(registered, `chat-whitelisted tool "${name}" must be registered and visible to non-admins`).toContain(name)
    }
  })
})
