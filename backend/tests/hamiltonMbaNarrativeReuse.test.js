/**
 * MBA-level writing everywhere — regression tests for reusing the ONE drafted
 * proposal (hamiltonFullProposalGenerator, persona hamilton-mba-2026) across:
 *   - the PORTAL pathway (buildPortalNarrativeAnswers → engine essay/goals), and
 *   - the PACKET generator (buildPacketNarrativeOverrides → buildPacketContent).
 *
 * Pins:
 *   - proposal sections map onto the engine's long-form keys; sections carrying
 *     an "[ EVIDENCE NEEDED: … ]" placeholder are NEVER typed into a live portal;
 *   - packet narrative sections prefer the MBA prose over raw profile essays,
 *     and no false "missing personal statement" is flagged when the MBA draft
 *     supplied one;
 *   - the engine's narrative override applies ONLY to the long-form allow-list —
 *     short factual fields always stay the profile's verbatim values.
 */
import { describe, it, expect } from 'vitest'

const {
  buildPortalNarrativeAnswers,
  buildPacketNarrativeOverrides,
} = await import('../services/hamilton/hamiltonFullProposalGenerator.js')
const { buildPacketContent } = await import('../services/hamilton/hamiltonApplicationPacketGenerator.js')
const { _internal: engineInternal } = await import('../services/hamilton/hamiltonAutopilotEngine.js')

const proposal = {
  ok: true,
  kind: 'individual',
  sections: [
    { key: 'cover_letter', title: 'Cover Letter', content: 'Dear Committee — a professionally drafted cover letter.' },
    { key: 'need_statement', title: 'Statement of Need', content: 'A rigorous, evidence-led statement of need.' },
    { key: 'goals_objectives', title: 'Goals & Objectives (SMART)', content: 'SMART objective 1; SMART objective 2.' },
    { key: 'personal_capacity', title: 'Readiness & Personal Capacity', content: 'Demonstrated readiness grounded in the profile.' },
  ],
}

describe('buildPortalNarrativeAnswers', () => {
  it('maps drafted sections onto the engine essay/goals keys', () => {
    const answers = buildPortalNarrativeAnswers(proposal)
    expect(answers.essay).toContain('A rigorous, evidence-led statement of need.')
    expect(answers.essay).toContain('Demonstrated readiness grounded in the profile.')
    expect(answers.goals).toBe('SMART objective 1; SMART objective 2.')
  })

  it('never types an [ EVIDENCE NEEDED ] placeholder into a live portal field', () => {
    const withGap = {
      ...proposal,
      sections: [
        { key: 'need_statement', title: 'Need', content: 'Needs [ EVIDENCE NEEDED: household income ] to complete.' },
        { key: 'goals_objectives', title: 'Goals', content: 'Clean SMART goals.' },
      ],
    }
    const answers = buildPortalNarrativeAnswers(withGap)
    expect(answers.essay).toBeUndefined()
    expect(answers.goals).toBe('Clean SMART goals.')
  })

  it('returns {} for a missing/failed proposal', () => {
    expect(buildPortalNarrativeAnswers(null)).toEqual({})
    expect(buildPortalNarrativeAnswers({ sections: [] })).toEqual({})
  })
})

describe('buildPacketNarrativeOverrides', () => {
  it('maps need/personal/goals onto the packet narrative keys', () => {
    const o = buildPacketNarrativeOverrides(proposal)
    expect(o.statement_of_need).toBe('A rigorous, evidence-led statement of need.')
    expect(o.personal_statement).toBe('Demonstrated readiness grounded in the profile.')
    expect(o.goals).toBe('SMART objective 1; SMART objective 2.')
  })

  it('falls back to the cover letter for the personal narrative when no capacity section exists', () => {
    const p = { ...proposal, sections: proposal.sections.filter((s) => s.key !== 'personal_capacity') }
    const o = buildPacketNarrativeOverrides(p)
    expect(o.personal_statement).toBe('Dear Committee — a professionally drafted cover letter.')
  })
})

describe('buildPacketContent + narrativeOverrides', () => {
  const profile = {
    id: 'p1',
    basic_information: { first_name: 'Robert', last_name: 'White', email: 'r@example.com' },
    essays: { primary: 'raw profile essay text' },
  }
  const opportunity = { title: 'Test Grant', sponsor: 'Test Funder' }

  it('prefers the MBA-drafted prose over raw profile essays and drops the false missing flag', () => {
    const overrides = buildPacketNarrativeOverrides(proposal)
    const content = buildPacketContent({ opportunity, profile, automationType: 'mail', narrativeOverrides: overrides })
    const bodyByHeading = Object.fromEntries(content.sections.map((s) => [s.heading, s.body]))
    expect(bodyByHeading['Statement of Need']).toBe('A rigorous, evidence-led statement of need.')
    expect(bodyByHeading['Personal / Student Narrative']).toBe('Demonstrated readiness grounded in the profile.')
    expect(bodyByHeading['Career Goals']).toBe('SMART objective 1; SMART objective 2.')
    expect(content.missing.find((m) => m.key === 'personal_statement')).toBeUndefined()
  })

  it('falls back to the raw essays without overrides (unchanged behavior)', () => {
    const content = buildPacketContent({ opportunity, profile, automationType: 'mail' })
    const bodyByHeading = Object.fromEntries(content.sections.map((s) => [s.heading, s.body]))
    expect(bodyByHeading['Personal / Student Narrative']).toBe('raw profile essay text')
  })
})

describe('engine applyNarrativeAnswers', () => {
  it('overrides ONLY the long-form keys; factual fields stay verbatim', () => {
    const values = { first_name: 'Robert', essay: 'raw essay', goals: 'raw goals' }
    const out = engineInternal.applyNarrativeAnswers(values, {
      essay: 'MBA essay', goals: 'MBA goals',
      first_name: 'INJECTED', // must be ignored — not on the allow-list
    })
    expect(out.essay).toBe('MBA essay')
    expect(out.goals).toBe('MBA goals')
    expect(out.first_name).toBe('Robert')
  })

  it('leaves profile values in place when no narrative was drafted', () => {
    const values = { essay: 'raw essay' }
    expect(engineInternal.applyNarrativeAnswers(values, null).essay).toBe('raw essay')
    expect(engineInternal.applyNarrativeAnswers(values, { essay: '  ' }).essay).toBe('raw essay')
  })
})
