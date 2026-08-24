/**
 * profileCompletionGate — the PROFILE-COMPLETION GATE.
 *
 * Covers: the required-fields resolver per type (individual / org / student),
 * the missing-count + numbering (N total, sequential 1..N indices), the gate
 * blocks-until-complete, and the admin exemption.
 */
import { describe, it, expect } from 'vitest'
import {
  REQUIRED_DATA_POINTS,
  classifyProfileType,
  resolveRequiredDataPoints,
  computeProfileCompletionGate,
  resolveProfileCompletionForUser,
} from '../services/profileCompletionGate.js'

describe('classifyProfileType', () => {
  it('classifies individual / student / org / business', () => {
    expect(classifyProfileType('individual')).toMatchObject({ isPerson: true, isStudent: false, isOrg: false })
    expect(classifyProfileType('high_school_student')).toMatchObject({ isPerson: true, isStudent: true, isOrg: false })
    expect(classifyProfileType('nonprofit')).toMatchObject({ isOrg: true, isPerson: false, isStudent: false })
    expect(classifyProfileType('business')).toMatchObject({ isOrg: true, isBusiness: true })
  })

  it('unclassified / other falls through to the person baseline (never under-asks)', () => {
    expect(classifyProfileType('other')).toMatchObject({ isPerson: true, isOrg: false })
    expect(classifyProfileType(null)).toMatchObject({ isPerson: true, isOrg: false })
  })
})

describe('resolveRequiredDataPoints — required set is RELEVANT TO THE TYPE', () => {
  it('an INDIVIDUAL requires name + state + need + financial (no org fields)', () => {
    const ids = resolveRequiredDataPoints('individual').map((d) => d.id)
    expect(ids).toEqual(['full_name', 'state', 'need_categories', 'financial_need'])
    expect(ids).not.toContain('organization_type')
    expect(ids).not.toContain('intended_major')
  })

  it('a STUDENT requires name + state + need + financial + education + major', () => {
    const ids = resolveRequiredDataPoints('college_student').map((d) => d.id)
    expect(ids).toEqual(
      expect.arrayContaining(['full_name', 'state', 'education_level', 'intended_major']),
    )
    expect(ids).not.toContain('organization_type')
  })

  it('an ORG requires name + state + organization_type + mission + focus (no person/student fields)', () => {
    const ids = resolveRequiredDataPoints('nonprofit').map((d) => d.id)
    expect(ids).toEqual(['full_name', 'state', 'organization_type', 'mission', 'focus_areas'])
    expect(ids).not.toContain('need_categories')
    expect(ids).not.toContain('education_level')
  })

  it('every required data point declares a persistable write target', () => {
    for (const dp of REQUIRED_DATA_POINTS) {
      expect(dp.question.writes.section).toBeTruthy()
      expect(dp.question.writes.field).toBeTruthy()
      expect(typeof dp.present).toBe('function')
    }
  })
})

describe('computeProfileCompletionGate — missing detection + numbering', () => {
  it('an essentially-empty individual is BLOCKED with sequential 1..N numbering', () => {
    const gate = computeProfileCompletionGate(
      { id: 'p1', primary_type: 'individual', display_name: 'Kathy Jones' },
      {},
    )
    // display_name satisfies full_name; the other three individual fields are missing.
    expect(gate.complete).toBe(false)
    expect(gate.blocked).toBe(true)
    const N = gate.questions.length
    expect(N).toBe(gate.missing.length)
    expect(N).toBeGreaterThan(0)
    // Sequential indices 1..N, and every question carries total === N.
    expect(gate.questions.map((q) => q.index)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    )
    expect(gate.questions.every((q) => q.total === N)).toBe(true)
    // Intro explains they cannot proceed and names the count.
    expect(gate.intro).toMatch(/cannot proceed/i)
    expect(gate.intro).toContain(String(N))
  })

  it('N counts only MISSING required points — a partially-filled profile shrinks N', () => {
    const empty = computeProfileCompletionGate({ id: 'p', primary_type: 'individual', display_name: 'A B' }, {})
    const partial = computeProfileCompletionGate(
      { id: 'p', primary_type: 'individual', display_name: 'A B' },
      { basic_information: { state: 'TN' }, financial_information: { assistance_needs: ['housing'] } },
    )
    expect(partial.questions.length).toBe(empty.questions.length - 2)
    expect(partial.questions.map((q) => q.index)).toEqual(
      Array.from({ length: partial.questions.length }, (_, i) => i + 1),
    )
    expect(partial.questions.every((q) => q.total === partial.questions.length)).toBe(true)
  })

  it('a fully-answered individual is COMPLETE and NOT blocked (gate opens)', () => {
    const gate = computeProfileCompletionGate(
      { id: 'p', primary_type: 'individual', display_name: 'Kathy Jones', state: 'TN' },
      {
        basic_information: { full_name: 'Kathy Jones', state: 'TN' },
        financial_information: { assistance_needs: ['housing', 'utilities'], financial_need_level: 'high' },
      },
    )
    expect(gate.complete).toBe(true)
    expect(gate.blocked).toBe(false)
    expect(gate.questions).toEqual([])
    expect(gate.intro).toBeNull()
  })

  it('a STUDENT is asked education + major but never org questions', () => {
    const gate = computeProfileCompletionGate(
      { id: 's', primary_type: 'high_school_student', display_name: 'Demo Student', state: 'TN' },
      { basic_information: { state: 'TN' }, financial_information: { assistance_needs: ['scholarship'], financial_need_level: 'high' } },
    )
    const ids = gate.questions.map((q) => q.id)
    expect(ids).toEqual(expect.arrayContaining(['education_level', 'intended_major']))
    expect(ids).not.toContain('organization_type')
    // education answered → that question drops, N shrinks, renumbering stays 1..N.
    const gate2 = computeProfileCompletionGate(
      { id: 's', primary_type: 'high_school_student', display_name: 'Demo Student', state: 'TN' },
      {
        basic_information: { state: 'TN' },
        financial_information: { assistance_needs: ['scholarship'], financial_need_level: 'high' },
        education: { highest_level: 'High school senior', intended_major: 'Forensic Science' },
      },
    )
    expect(gate2.complete).toBe(true)
  })

  it('an ORG gate asks organization_type + mission + focus and blocks until filled', () => {
    const gate = computeProfileCompletionGate(
      { id: 'o', primary_type: 'nonprofit', display_name: 'Focus Forward Ministry', state: 'OH' },
      { basic_information: { state: 'OH' } },
    )
    expect(gate.blocked).toBe(true)
    expect(gate.questions.map((q) => q.id)).toEqual(['organization_type', 'mission', 'focus_areas'])
    // A bare/generic organization_type does NOT satisfy the requirement.
    const generic = computeProfileCompletionGate(
      { id: 'o', primary_type: 'nonprofit', display_name: 'Org', state: 'OH' },
      { basic_information: { state: 'OH' }, organization_details: { organization_type: 'organization' } },
    )
    expect(generic.questions.map((q) => q.id)).toContain('organization_type')
    const filled = computeProfileCompletionGate(
      { id: 'o', primary_type: 'nonprofit', display_name: 'Focus Forward Ministry', state: 'OH' },
      {
        basic_information: { state: 'OH' },
        organization_details: { organization_type: 'church' },
        narrative: { mission: 'Deliver building supplies to families in need.' },
        programs_services: { focus_areas: ['housing', 'community'] },
      },
    )
    expect(filled.complete).toBe(true)
  })
})

// --- resolveProfileCompletionForUser (admin exemption + payload summary) -----

function makeFakeDb(sectionsByProfile) {
  return {
    prepare(sql) {
      return {
        all: async (profileId) => {
          const secs = sectionsByProfile[profileId] || {}
          return Object.entries(secs).map(([section_key, data]) => ({ section_key, data: JSON.stringify(data) }))
        },
      }
    },
  }
}

describe('resolveProfileCompletionForUser — admin exemption + gate surface', () => {
  it('ADMINS are NEVER gated (exempt, not blocked) even with an empty profile', async () => {
    const db = makeFakeDb({ a1: {} })
    const out = await resolveProfileCompletionForUser(
      db,
      { id: 'admin', is_admin: true },
      [{ id: 'a1', display_name: 'Owner', primary_type: 'individual' }],
    )
    expect(out).toMatchObject({ active: false, blocked: false, exempt: 'admin' })
    expect(out.next).toBeNull()
  })

  it('a NON-admin with an incomplete profile is blocked and carries the numbered next-gate', async () => {
    const db = makeFakeDb({ u1: { basic_information: {} } })
    const out = await resolveProfileCompletionForUser(
      db,
      { id: 'user', is_admin: false },
      [{ id: 'u1', display_name: 'Real Person', primary_type: 'individual' }],
    )
    expect(out.active).toBe(true)
    expect(out.blocked).toBe(true)
    expect(out.next).toBeTruthy()
    expect(out.next.profile_id).toBe('u1')
    const N = out.next.questions.length
    expect(N).toBeGreaterThan(0)
    expect(out.next.questions.map((q) => q.total)).toEqual(Array(N).fill(N))
    expect(out.profiles[0]).toMatchObject({ profile_id: 'u1', complete: false, remaining: N })
  })

  it('a NON-admin whose profiles are all complete is NOT blocked', async () => {
    const db = makeFakeDb({
      u1: {
        basic_information: { full_name: 'Real Person', state: 'TN' },
        financial_information: { assistance_needs: ['food'], financial_need_level: 'moderate' },
      },
    })
    const out = await resolveProfileCompletionForUser(
      db,
      { id: 'user', is_admin: false },
      [{ id: 'u1', display_name: 'Real Person', primary_type: 'individual', state: 'TN' }],
    )
    expect(out.blocked).toBe(false)
    expect(out.next).toBeNull()
  })

  it('synthetic agent:amy and deleted profiles are skipped', async () => {
    const db = makeFakeDb({ amy: {}, gone: {} })
    const out = await resolveProfileCompletionForUser(
      db,
      { id: 'user', is_admin: false },
      [
        { id: 'amy', display_name: 'Synth', primary_type: 'individual', created_by: 'agent:amy' },
        { id: 'gone', display_name: 'Deleted', primary_type: 'individual', status: 'deleted' },
      ],
    )
    expect(out.blocked).toBe(false)
    expect(out.profiles).toEqual([])
  })
})
