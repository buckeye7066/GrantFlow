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

  it('scored:false prose (narrative.mission / notes) is NOT mined into the keyword inventory', () => {
    const sig = buildProfileSignals({
      profile: {},
      sections: {
        basic_information: { state: 'TN', notes: 'zqxwobblegonk' },
        narrative: { mission: 'flibberjibbet', barriers_faced: 'wumptastic' },
        financial_information: { notes: 'gronktacular' },
      },
    })
    const keywords = (sig.keywords ?? []).map((k) => String(k).toLowerCase())
    for (const prose of ['zqxwobblegonk', 'flibberjibbet', 'wumptastic', 'gronktacular']) {
      expect(keywords, `${prose} must not be a mined keyword`).not.toContain(prose)
    }
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
