/**
 * Comparable-awards grounding in the Hamilton proposal generator.
 *
 * Proves the G0 separation contract:
 *   1. Awards render as a clearly-labeled REFERENCE-ONLY prompt block.
 *   2. They are NOT injected into the applicant evidence pack — so the
 *      fabrication guard still treats the profile as the only source of
 *      applicant truth (an award fact can't launder into an applicant claim).
 *   3. meta.comparable_award_count is traceable on the result.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  generateMbaProposal,
  buildEvidencePack,
  resolveProfileKind,
  _internal,
} from '../services/hamilton/hamiltonFullProposalGenerator.js'

const PROFILE = {
  id: 'profile-1',
  basic_information: { first_name: 'Pat', last_name: 'Doe', city: 'Nashville', state: 'TN' },
  essays: { personal_statement: 'I want to expand rural health outreach.' },
}

const AWARDS = [
  {
    title: 'Rural Health Outreach Project',
    recipient: 'State University',
    amount: 250000,
    agency: 'HRSA',
    detail_url: 'https://reporter.nih.gov/project-details/123',
    reference_only: true,
  },
]

describe('buildComparableAwardsBlock', () => {
  it('renders a labeled reference-only block with the real award facts', () => {
    const block = _internal.buildComparableAwardsBlock(AWARDS)
    expect(block).toContain('REFERENCE ONLY')
    expect(block).toContain('NOT APPLICANT FACTS')
    expect(block).toContain('Rural Health Outreach Project')
    expect(block).toContain('State University')
    expect(block).toContain('$250,000')
  })

  it('renders nothing for empty/invalid input (no placeholder padding)', () => {
    expect(_internal.buildComparableAwardsBlock([])).toBe('')
    expect(_internal.buildComparableAwardsBlock(null)).toBe('')
    expect(_internal.buildComparableAwardsBlock([{ notitle: true }])).toBe('')
  })
})

describe('generateMbaProposal with comparable awards', () => {
  it('feeds awards into the prompt as reference context but keeps them OUT of the evidence pack', async () => {
    let capturedPrompt = null
    const invokeJson = vi.fn(async ({ prompt }) => {
      capturedPrompt = prompt
      return {
        ok: true,
        provider: 'openai',
        json: {
          sections: [{ key: 'need_statement', title: 'Statement of Need', content: 'Grounded need text.', evidence_gaps: [] }],
          funder_alignment: { requirements: [], alignment: [] },
          evidence_gaps: [],
          recommendations: [],
        },
      }
    })

    const result = await generateMbaProposal(null, {
      profile: PROFILE,
      grant: { id: 'grant-1', title: 'Health Grant', funder: 'Foundation' },
      comparableAwards: AWARDS,
      _deps: { invokeJson, getOpenAIOptional: () => null },
    })

    expect(result.ok).toBe(true)
    expect(result.meta.comparable_award_count).toBe(1)

    // Prompt carries the labeled reference block…
    expect(capturedPrompt).toContain('COMPARABLE FUNDED AWARDS (REFERENCE ONLY')
    expect(capturedPrompt).toContain('Rural Health Outreach Project')

    // …but the evidence pack (the fabrication guard's ONLY ground truth)
    // contains no trace of the reference awards.
    const evidence = buildEvidencePack(PROFILE, resolveProfileKind(PROFILE))
    const evidenceText = JSON.stringify(evidence)
    expect(evidenceText).not.toContain('Rural Health Outreach Project')
    expect(evidenceText).not.toContain('State University')
  })

  it('passing no awards (flag off upstream) omits the reference block entirely', async () => {
    let capturedPrompt = null
    const invokeJson = vi.fn(async ({ prompt }) => {
      capturedPrompt = prompt
      return {
        ok: true,
        provider: 'openai',
        json: {
          sections: [{ key: 'need_statement', title: 'Statement of Need', content: 'Text.', evidence_gaps: [] }],
        },
      }
    })

    const result = await generateMbaProposal(null, {
      profile: PROFILE,
      grant: null, // no grant → no internal comparable-awards fetch either
      comparableAwards: [],
      _deps: { invokeJson, getOpenAIOptional: () => null },
    })

    expect(result.ok).toBe(true)
    expect(result.meta.comparable_award_count).toBe(0)
    expect(capturedPrompt).not.toContain('COMPARABLE FUNDED AWARDS')
  })
})
