/**
 * Owner 2026-09-05: "A profile is only in GrantFlow if it has a need. To say
 * there are no inferred needs means the profile has not been properly parsed."
 */
import { describe, expect, it } from 'vitest'
import { buildProfileNeedSuggestions, SUGGESTION_BASIS } from '../services/needs/profileNeedSuggestions.js'
import { classifyFunderLead } from '../services/funderLead.js'

describe('buildProfileNeedSuggestions — the list is never empty for a parsed profile', () => {
  it('a student who declares canonical needs but no purchasable item gets her DECLARED needs, not "no inferred needs"', () => {
    const out = buildProfileNeedSuggestions({
      profile: { id: 'p-a', primary_type: 'college_student' },
      sections: { financial_information: { needs: ['education', 'housing'] }, education: { current_institution: 'Middle Tennessee State University' } },
    })
    expect(out.parse_failure).toBe(false)
    expect(out.basis).toBe(SUGGESTION_BASIS.DECLARED_NEEDS)
    expect(out.suggestions.map((s) => s.need_code)).toEqual(expect.arrayContaining(['education', 'housing']))
    expect(out.suggestions[0].name).toMatch(/^[A-Z]/)
  })

  it('a declared purchasable item wins the first tier', () => {
    const out = buildProfileNeedSuggestions({
      profile: { id: 'p-b', primary_type: 'nonprofit' },
      sections: { financial_information: { item_needs: ['15 passenger van'] }, organization_details: { organization_type: 'nonprofit' } },
    })
    expect(out.basis).toBe(SUGGESTION_BASIS.DECLARED_ITEMS)
    expect(out.suggestions.some((s) => /van/i.test(s.name))).toBe(true)
  })

  it('an organization with no declared item falls to its needs plan', () => {
    const out = buildProfileNeedSuggestions({
      profile: { id: 'p-c', primary_type: 'nonprofit' },
      sections: { organization_details: { organization_type: 'nonprofit', organization_name: 'Vermilion Church' } },
    })
    expect(out.parse_failure).toBe(false)
    expect([SUGGESTION_BASIS.NEEDS_PLAN, SUGGESTION_BASIS.DECLARED_NEEDS]).toContain(out.basis)
    expect(out.suggestions.length).toBeGreaterThan(0)
  })

  it('a profile with NOTHING readable is a PARSE FAILURE, named as such', () => {
    const out = buildProfileNeedSuggestions({ profile: { id: 'p-d' }, sections: {} })
    expect(out.parse_failure).toBe(true)
    expect(out.basis).toBe(SUGGESTION_BASIS.PARSE_FAILURE)
    expect(out.suggestions).toEqual([])
    expect(out.message).toMatch(/not parsed correctly/)
  })
})

describe('classifyFunderLead — a 990 grantmaker is a lead, an award is not', () => {
  it('recognizes the ProPublica grantmaker row the Foundation page posts', () => {
    const lead = classifyFunderLead({
      title: 'Johnson Community Foundation — Foundation/Grantmaker', sponsor: 'Johnson Community Foundation', source: 'propublica.990',
      source_id: '844611712', application_url: null, type: 'DIRECTORY', funding_source_type: 'foundation',
    })
    expect(lead).toEqual(expect.objectContaining({ name: 'Johnson Community Foundation', ein: '844611712', reason: 'source:propublica.990' }))
  })
  it('a real award with an application URL is never a funder lead', () => {
    expect(classifyFunderLead({ title: 'AFTE Forensic Science Scholarship', sponsor: 'AFTE', application_url: 'https://www.afte.org/scholarship', source: 'web_search' })).toBeNull()
    expect(classifyFunderLead({ title: 'Community Foundation Scholarship Program', sponsor: 'Community Foundation of Greater Chattanooga', application_url: 'https://cfgc.org/scholarships', funding_source_type: 'foundation' })).toBeNull()
  })
})
