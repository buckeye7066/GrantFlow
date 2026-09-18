import { expect, it } from 'vitest'
import { buildProfileNeedSuggestions, SUGGESTION_BASIS } from '../services/needs/profileNeedSuggestions.js'
import { deriveOrgNeeds } from '../services/needs/orgNeedsTaxonomy.js'

it('renders the structured needs-plan key, not an object serialization, in Smart Matcher', () => {
  const context = { profile: { id: 'need-label-fixture', primary_type: 'nonprofit' }, sections: { organization_details: { organization_type: 'nonprofit' } } }
  const plan = deriveOrgNeeds(context)
  const result = buildProfileNeedSuggestions(context)
  expect(result.basis).toBe(SUGGESTION_BASIS.NEEDS_PLAN)
  expect(result.suggestions.length).toBeGreaterThan(0)
  for (const suggestion of result.suggestions) {
    expect(suggestion.reasons).toEqual([`Needs plan for a ${plan.blueprint.key.replace(/_/g, ' ')}`])
    expect(suggestion.reasons.join(' ')).not.toContain('[object Object]')
  }
})
