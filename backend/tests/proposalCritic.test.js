/**
 * Tests for backend/services/proposalCritic.js (PROPOSAL_CRITIC flag).
 *
 * Proves:
 *   1. Flag OFF (default) → { enabled:false } and zero LLM calls.
 *   2. Flag ON → two bounded passes (compliance + consistency), normalized
 *      findings, and honest { available:false } when a provider fails —
 *      never invented feedback (G0/G1).
 *   3. The deterministic fabrication-guard scan flags unevidenced identity
 *      claims even with NO LLM configured.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { runProposalCritic, isProposalCriticEnabled } from '../services/proposalCritic.js'

const savedFlag = process.env.PROPOSAL_CRITIC
afterEach(() => {
  if (savedFlag === undefined) delete process.env.PROPOSAL_CRITIC
  else process.env.PROPOSAL_CRITIC = savedFlag
})

const GRANT = {
  id: 'grant-1',
  profile_id: 'profile-1',
  title: 'Community Health Grant',
  funder: 'Health Foundation',
  program_description: 'Supports community health programs.',
  eligibility_summary: 'Nonprofits in Tennessee.',
  selection_criteria: 'Impact, feasibility, sustainability.',
}

describe('proposal critic flag', () => {
  it('defaults OFF and returns enabled:false without touching an LLM', async () => {
    delete process.env.PROPOSAL_CRITIC
    expect(isProposalCriticEnabled()).toBe(false)
    const invokeJson = vi.fn()
    const result = await runProposalCritic(null, {
      grant: GRANT,
      proposalText: 'A draft.',
      _deps: { invokeJson, getOpenAIOptional: () => null, loadProfileBundle: async () => null },
    })
    expect(result.enabled).toBe(false)
    expect(invokeJson).not.toHaveBeenCalled()
  })
})

describe('critic passes (flag ON)', () => {
  it('runs both passes, normalizes findings, and bounds token cost', async () => {
    process.env.PROPOSAL_CRITIC = '1'
    const invokeJson = vi.fn(async ({ prompt }) => {
      if (prompt.includes('compliance reviewer')) {
        return {
          ok: true,
          provider: 'openai',
          json: {
            summary: 'Mostly responsive.',
            responsiveness_score: 141, // must clamp to 100
            findings: [
              { criterion: 'Sustainability plan', status: 'MISSING', severity: 'HIGH', recommendation: 'Add a sustainability section.' },
              { bogus: true }, // dropped — no content fields
            ],
          },
        }
      }
      return {
        ok: true,
        provider: 'anthropic',
        json: {
          summary: 'One unsupported claim.',
          findings: [
            { claim: 'We served 10,000 patients', status: 'unsupported', severity: 'high', recommendation: 'Add real service numbers to the profile.' },
          ],
        },
      }
    })

    const result = await runProposalCritic(null, {
      grant: GRANT,
      proposalText: 'We will expand community health outreach. We served 10,000 patients.',
      _deps: {
        invokeJson,
        getOpenAIOptional: () => null,
        loadProfileBundle: async () => ({ id: 'profile-1', sections: { basic_information: { first_name: 'Pat' } } }),
      },
    })

    expect(result.enabled).toBe(true)
    expect(invokeJson).toHaveBeenCalledTimes(2)
    // Bounded cost: every pass capped at a small max_tokens.
    for (const call of invokeJson.mock.calls) {
      expect(call[0].maxTokens).toBeLessThanOrEqual(800)
    }

    const compliance = result.passes.find((p) => p.key === 'compliance')
    expect(compliance.available).toBe(true)
    expect(compliance.responsiveness_score).toBe(100) // clamped
    expect(compliance.findings).toHaveLength(1)
    expect(compliance.findings[0]).toMatchObject({ status: 'missing', severity: 'high' })

    const consistency = result.passes.find((p) => p.key === 'consistency')
    expect(consistency.available).toBe(true)
    expect(consistency.findings[0]).toMatchObject({ claim: 'We served 10,000 patients', status: 'unsupported' })
  })

  it('reports a failed pass as unavailable instead of inventing feedback', async () => {
    process.env.PROPOSAL_CRITIC = '1'
    const invokeJson = vi.fn(async () => ({ ok: false, provider: 'fallback', json: null }))
    const result = await runProposalCritic(null, {
      grant: GRANT,
      proposalText: 'A draft.',
      _deps: { invokeJson, getOpenAIOptional: () => null, loadProfileBundle: async () => null },
    })
    expect(result.passes.every((p) => p.available === false)).toBe(true)
    expect(result.passes.every((p) => !p.findings)).toBe(true)
  })

  it('deterministically flags unevidenced identity claims with no LLM at all', async () => {
    process.env.PROPOSAL_CRITIC = '1'
    const invokeJson = vi.fn(async () => ({ ok: false, provider: 'fallback', json: null }))
    const result = await runProposalCritic(null, {
      grant: GRANT,
      proposalText: 'As a veteran, I understand service. I am a first-generation college student.',
      _deps: {
        invokeJson,
        getOpenAIOptional: () => null,
        // Profile has NO veteran / first-gen evidence.
        loadProfileBundle: async () => ({ id: 'profile-1', sections: { basic_information: { first_name: 'Pat' } } }),
      },
    })
    const classes = result.deterministic_flags.map((f) => f.class)
    expect(classes).toContain('veteran')
    expect(classes).toContain('first_generation')
  })

  it('truncates oversized drafts (bounded input)', async () => {
    process.env.PROPOSAL_CRITIC = '1'
    let seenPromptLength = 0
    const invokeJson = vi.fn(async ({ prompt }) => {
      seenPromptLength = Math.max(seenPromptLength, prompt.length)
      return { ok: false, provider: 'fallback', json: null }
    })
    const huge = 'x'.repeat(60_000)
    const result = await runProposalCritic(null, {
      grant: GRANT,
      proposalText: huge,
      _deps: { invokeJson, getOpenAIOptional: () => null, loadProfileBundle: async () => null },
    })
    expect(result.meta.truncated).toBe(true)
    expect(result.meta.draft_chars).toBe(60_000)
    expect(seenPromptLength).toBeLessThan(20_000)
  })
})
