import { describe, it, expect } from 'vitest'
import {
  serializeAnyaApplicationContext,
  ANYA_WORKING_CONTEXT_MAX_CHARS,
} from '../services/anyaProfileVisibility.js'

/**
 * Anya's WORKING context — what is missing, what the pipeline is doing, what
 * she remembers.
 *
 * The owner's report was that Anya "does not have the true ability or tools to
 * help profile users with tasks within their profiles" and "cannot see their
 * profile". Half of that was already fixed: loadAnyaProfileSnapshot gives her a
 * redacted view of the profile's FIELDS, and this file does not claim otherwise.
 *
 * The half that was NOT fixed is the actionable half. backend/services/
 * anyaContextBuilder.js — 715 lines — builds profile GAPS ranked by which
 * missing sections unlock the most matches, a results/matching snapshot,
 * pipeline status, partial-failure submission warnings, and profile-scoped
 * memory so she can pick up where a conversation left off.
 *
 * It had ZERO importers anywhere in the repo. Written, never called. Knowing a
 * profile's fields tells Anya what IS there; only this tells her what to do
 * about what is not.
 *
 * Two properties are pinned here, and the second is the subtle one.
 */

const bigProfile = (chars) => ({
  profile: { id: 'p1', name: 'X'.repeat(200) },
  sections: { narrative: { body: 'y'.repeat(chars) } },
  available_sections: ['narrative'],
})

describe('the working context survives serialization', () => {
  it('is carried through when everything fits', () => {
    const out = serializeAnyaApplicationContext({
      current_user: { display_name: 'Dr. White', is_admin: false },
      profile_working_context: '[PROFILE GAPS] financial_information is missing.',
      active_profile: { profile: { id: 'p1' } },
    })
    expect(out).toContain('profile_working_context')
    expect(out).toContain('financial_information is missing')
  })

  /**
   * THE SUBTLE ONE. The deepest degradation tier does NOT spread the incoming
   * object — it rebuilds it from an explicit key list, so any field not named
   * there is dropped without a word. A new field added to applicationContext is
   * silently discarded under exactly the context pressure that makes it most
   * valuable, and the emitted context_notice says nothing about it.
   *
   * That tier is also where the profile's SECTIONS get emptied — so it is the
   * moment Anya most needs to know what is missing and what the pipeline is
   * doing, and the moment she would have been told the least.
   */
  it('SURVIVES the deepest budget tier, where profile sections are emptied', () => {
    const gaps = '[PROFILE GAPS] financial_information and housing are missing.'
    const out = serializeAnyaApplicationContext({
      current_user: { display_name: 'Dr. White', is_admin: false },
      profile_working_context: gaps,
      // Large enough to blow past every earlier tier.
      active_profile: bigProfile(200_000),
      current_page: { name: 'Profile', guidance: 'g', snapshot: { big: 'z'.repeat(50_000) } },
    })

    // Prove we actually reached the deepest tier, or this asserts nothing.
    expect(out).toContain('exceeded the context budget')
    expect(JSON.parse(out).active_profile.sections).toEqual({})

    expect(out).toContain('profile_working_context')
    expect(JSON.parse(out).profile_working_context).toBe(gaps)
  })

  it('a null working context serializes as null rather than vanishing', () => {
    const parsed = JSON.parse(serializeAnyaApplicationContext({
      current_user: { display_name: 'X', is_admin: false },
      profile_working_context: null,
      active_profile: { profile: { id: 'p1' } },
    }))
    expect(parsed).toHaveProperty('profile_working_context')
    expect(parsed.profile_working_context).toBeNull()
  })

  it('has its own budget, smaller than the profile snapshot it rides beside', () => {
    expect(ANYA_WORKING_CONTEXT_MAX_CHARS).toBeGreaterThan(0)
    expect(ANYA_WORKING_CONTEXT_MAX_CHARS).toBeLessThan(30000)
  })
})

describe('the builder is actually reachable now', () => {
  it('anyaContextBuilder exports the function the orchestrator calls', async () => {
    const mod = await import('../services/anyaContextBuilder.js')
    expect(typeof mod.buildAnyaContext).toBe('function')
  })

  it('the orchestrator imports it — a builder with no importer is the whole defect', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../services/anyaOrchestrator.js', import.meta.url), 'utf8',
    )
    expect(src).toMatch(/import \{ buildAnyaContext \} from '\.\/anyaContextBuilder\.js'/)
    // Imported AND called. An unused import would satisfy the line above.
    expect(src).toMatch(/await buildAnyaContext\(/)
    // And the result reaches the model rather than a local variable.
    expect(src).toMatch(/profile_working_context: profileWorkingContext/)
  })

  it('the working context is built for the ACTIVE profile, not a hardcoded one', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../services/anyaOrchestrator.js', import.meta.url), 'utf8',
    )
    const call = src.slice(src.indexOf('await buildAnyaContext('), src.indexOf('await buildAnyaContext(') + 260)
    expect(call).toMatch(/profileId: activeProfileId/)
    expect(call).toMatch(/currentPage: resolvedPage/)
  })

  it('a builder failure must not take the whole reply down', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      new URL('../services/anyaOrchestrator.js', import.meta.url), 'utf8',
    )
    const region = src.slice(src.indexOf('let profileWorkingContext'), src.indexOf('const applicationContext'))
    expect(region).toMatch(/catch/)
    // Anya answering with less context beats Anya not answering.
    expect(region).toMatch(/working context unavailable/)
  })
})
