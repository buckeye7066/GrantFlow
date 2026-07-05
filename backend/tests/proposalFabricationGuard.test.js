/**
 * Tests for proposalFabricationGuard — the deterministic identity-claim gate
 * on Hamilton's drafted proposals.
 *
 * Production incident (2026-07-05): Hamilton drafted "As a member of the
 * LGBTQ+ community, I face unique challenges..." for an applicant whose
 * profile contains no such signal — a fabricated protected-identity claim
 * shaped to fit the funder's priorities. The prompt-level fabrication rule is
 * advisory; this guard is the enforcement.
 */

import { describe, expect, it } from 'vitest'
import { applyFabricationGuard } from '../services/hamilton/proposalFabricationGuard.js'
import { generateMbaProposal } from '../services/hamilton/hamiltonFullProposalGenerator.js'

const proposalWith = (content, key = 'need_statement') => ({
  kind: 'individual',
  sections: [{ key, title: 'Statement of Need', content, evidence_gaps: [] }],
  funder_alignment: { requirements: [], alignment: [] },
  evidence_gaps: [],
  recommendations: [],
})

// Evidence pack with NO identity signals (the Robert incident shape).
const PLAIN_EVIDENCE = {
  applicant_name: 'Robert White',
  location: 'Cleveland, TN',
  annual_income: '28000',
  education: '{"school":"Cleveland State Community College"}',
}

describe('applyFabricationGuard — unevidenced identity claims', () => {
  it('replaces the exact production LGBTQ+ fabrication with an evidence placeholder', () => {
    const drafted = proposalWith(
      'As a member of the LGBTQ+ community, I face unique challenges that impact my educational pursuits. ' +
      'My household income is $28,000, supporting a family of five. ' +
      'This scholarship is crucial for me to continue my studies at Cleveland State Community College.',
    )
    const { proposal, flags } = applyFabricationGuard(drafted, PLAIN_EVIDENCE)
    const content = proposal.sections[0].content
    expect(flags.length).toBe(1)
    expect(flags[0].class).toBe('lgbtq')
    expect(content).not.toMatch(/member of the LGBTQ/i)
    expect(content).toMatch(/\[ EVIDENCE NEEDED: profile does not document LGBTQ\+ identity/)
    // Non-offending sentences survive untouched.
    expect(content).toMatch(/Cleveland State Community College/)
    // A required gap is recorded at section and top level.
    expect(proposal.evidence_gaps.some((g) => g.key === 'identity_lgbtq' && g.required)).toBe(true)
  })

  it('gates veteran, ethnicity, disability, gender, and first-gen claims', () => {
    const drafted = proposalWith(
      'As a veteran, I bring discipline to my studies. ' +
      'I identify as Hispanic. ' +
      'As a person with a disability, I have overcome many barriers. ' +
      'As a woman, I bring a needed perspective. ' +
      'I am a first-generation college student.',
    )
    const { proposal, flags } = applyFabricationGuard(drafted, PLAIN_EVIDENCE)
    const classes = flags.map((f) => f.class).sort()
    expect(classes).toEqual(
      ['disability', 'ethnicity_hispanic', 'first_generation', 'gender_female', 'veteran'],
    )
    expect(proposal.sections[0].content).not.toMatch(/as a veteran|identify as hispanic/i)
  })

  it('keeps claims the profile actually supports', () => {
    const drafted = proposalWith(
      'As a veteran, I bring discipline to my studies. I am a first-generation college student.',
    )
    const evidenced = {
      ...PLAIN_EVIDENCE,
      employment: '{"military_service":"US Army 2018-2024, honorable discharge"}',
      mission_or_personal_statement: 'First-generation college student pursuing nursing.',
    }
    const { proposal, flags } = applyFabricationGuard(drafted, evidenced)
    expect(flags).toEqual([])
    expect(proposal.sections[0].content).toMatch(/As a veteran/)
    expect(proposal.sections[0].content).toMatch(/first-generation/)
  })

  it('does not gate topical mentions of a community (only first-person claims)', () => {
    const drafted = proposalWith(
      'This funder has a long history of supporting LGBTQ+ students and veterans across Tennessee. ' +
      'I admire that mission and my goals align with expanding access to education.',
    )
    const { flags } = applyFabricationGuard(drafted, PLAIN_EVIDENCE)
    expect(flags).toEqual([])
  })

  it('handles empty/absent sections without throwing', () => {
    expect(applyFabricationGuard({ sections: [], evidence_gaps: [] }, PLAIN_EVIDENCE).flags).toEqual([])
    expect(applyFabricationGuard({}, PLAIN_EVIDENCE).flags).toEqual([])
  })
})

describe('generateMbaProposal — guard is wired into the generation path', () => {
  it('an LLM draft with a fabricated identity claim comes back placeholdered + flagged', async () => {
    const stubLlm = async () => ({
      ok: true,
      provider: 'stub',
      json: {
        sections: [
          {
            key: 'need_statement',
            title: 'Statement of Need',
            content: 'As a member of the LGBTQ+ community, I face unique challenges. I need tuition support to finish my degree.',
            evidence_gaps: [],
          },
        ],
        funder_alignment: { requirements: [], alignment: [] },
        evidence_gaps: [],
        recommendations: [],
      },
    })
    const profile = {
      id: 'prof-guard-1',
      display_name: 'Robert White',
      basic_information: { first_name: 'Robert', last_name: 'White', city: 'Cleveland', state: 'TN' },
      essays: { personal_statement: 'AEMT committed to emergency medical services.' },
    }
    const result = await generateMbaProposal(null, {
      profile,
      opportunity: { title: 'LGBTQ+ Scholarship', sponsor: 'Point Foundation' },
      _deps: { invokeJson: stubLlm, getOpenAIOptional: () => null },
    })
    expect(result.ok).toBe(true)
    expect(result.fabrication_flags.length).toBe(1)
    expect(result.meta.fabrication_flag_count).toBe(1)
    expect(result.sections[0].content).toMatch(/\[ EVIDENCE NEEDED: profile does not document LGBTQ\+ identity/)
    expect(result.sections[0].content).toMatch(/tuition support/)
    expect(result.evidence_gaps.some((g) => g.key === 'identity_lgbtq')).toBe(true)
  })
})
