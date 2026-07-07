import { describe, it, expect } from 'vitest'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { buildEvidencePack } from '../services/hamilton/hamiltonFullProposalGenerator.js'
import { _internal as packetInternal } from '../services/hamilton/hamiltonApplicationPacketGenerator.js'

const { readNarratives } = packetInternal

describe('profile schema redesign — signals read tags, prose is not mined', () => {
  it('funding_needs TAGS are read as clean need data points', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN' },
        financial_information: { funding_needs: ['housing', 'food'] },
      },
    })
    const needs = [...(sig.needs ?? [])]
    expect(needs).toContain('housing')
    expect(needs).toContain('food')
  })

  it('a legacy/custom funding_needs tag still normalizes through the matcher vocabulary', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN' },
        financial_information: { funding_needs: ['rental_assistance'] }, // alias → housing
      },
    })
    expect([...(sig.needs ?? [])]).toContain('housing')
  })

  it('prose keywords are excluded from the scoring DENOMINATOR (but still read for need derivation)', async () => {
    // Owner directive: free-text prose must not FLOOD scoring. The guarantee is
    // at the DENOMINATOR — mined keyword data points are excluded from the
    // coverage total — NOT a refusal to read the text (needs-silent ORGS derive
    // their need categories from mission/narrative text; gating the miner
    // destroyed org need derivation — the Focus Forward class).
    const { buildProfileDataPointInventory } = await import('../services/profileDataPoints.js')
    const sig = buildProfileSignals({
      profile: { primary_type: 'nonprofit' },
      sections: {
        basic_information: { state: 'TN' },
        narrative: {
          mission: 'We provide housing and food assistance to disabled veterans in rural Tennessee.',
          barriers_faced: 'transportation and utility hardship',
        },
      },
    })
    const inv = buildProfileDataPointInventory({ profile: { primary_type: 'nonprofit' }, signals: sig })
    // Prose DID inform need derivation (mission → housing/food needs).
    const needPoints = inv.dataPoints.filter((d) => d.kind === 'need')
    expect(needPoints.length, 'mission text should derive needs').toBeGreaterThan(0)
    // Prose words WERE mined as keyword points (so they can add matched credit)...
    const keywordPoints = inv.dataPoints.filter((d) => d.kind === 'keyword')
    expect(keywordPoints.length, 'mission words mined as keyword points').toBeGreaterThan(0)
    // ...but the coverage denominator (total) excludes gate + keyword kinds, so
    // prose can never flood the score. total = needs + identity/traits only.
    const denominatorCount = inv.dataPoints.filter(
      (d) => !['geo', 'applicant_type', 'keyword'].includes(d.kind),
    ).length
    expect(inv.total).toBe(denominatorCount)
    expect(inv.total).toBeLessThan(inv.dataPoints.length)
  })

  it('structured tag fields (focus_areas) still feed matchable signals', () => {
    const sig = buildProfileSignals({
      profile: { primary_type: 'nonprofit' },
      sections: {
        basic_information: { state: 'TN' },
        programs_services: { focus_areas: ['veteran'], interests: ['education'] },
      },
    })
    const interests = [...(sig.interests ?? [])].map((s) => String(s).toLowerCase())
    expect(interests.length).toBeGreaterThan(0)
  })
})

describe('Hamilton essay readers still resolve essays.* + fallbacks', () => {
  it('buildEvidencePack reads essays.* and falls back to org mission', () => {
    const withEssays = buildEvidencePack(
      { sections: { essays: { personal_statement: 'My story', goals: 'My goals', statement_of_need: 'I need help', financial_hardship: 'lost my job' } } },
      'individual',
    )
    expect(withEssays.mission_or_personal_statement).toBe('My story')
    expect(withEssays.goals).toBe('My goals')
    expect(withEssays.statement_of_need).toBe('I need help')
    expect(withEssays.financial_hardship).toBe('lost my job')

    // essays.primary is an accepted alias for the personal statement.
    const primaryOnly = buildEvidencePack({ sections: { essays: { primary: 'Primary story' } } }, 'individual')
    expect(primaryOnly.mission_or_personal_statement).toBe('Primary story')

    // Org mission fallback when no essays present.
    const orgFallback = buildEvidencePack({ sections: { organization_details: { mission: 'Serve the community' } } }, 'organization')
    expect(orgFallback.mission_or_personal_statement).toBe('Serve the community')
  })

  it('packet readNarratives resolves essays.* then top-level fallbacks', () => {
    // essays.* wins
    expect(readNarratives({ essays: { primary: 'Essay primary', goals: 'Essay goals' } }).personal_statement).toBe('Essay primary')
    expect(readNarratives({ essays: { personal_statement: 'PS' } }).personal_statement).toBe('PS')
    // top-level fallbacks still resolve (back-compat)
    expect(readNarratives({ personal_statement: 'Top level PS' }).personal_statement).toBe('Top level PS')
    expect(readNarratives({ goals: 'Top level goals' }).goals).toBe('Top level goals')
    expect(readNarratives({ career_goals: 'Career!' }).goals).toBe('Career!')
    expect(readNarratives({ statement_of_need: 'Need it' }).statement_of_need).toBe('Need it')
  })
})
