import {expect, it} from 'vitest'
import {expandNeed} from '../services/shared/needTaxonomy.js'
import {buildNeedWebQueries} from '../services/shared/liveWebSearch.js'
import {buildEndorsementPhrases, statesEndorsingPhrase, resolveNeedExpansion, buildItemLikeTerms} from '../services/itemNeedSearch.js'

it.each(['industrial food dehydrator', 'commercial food processor'])('does not search or endorse nutrition assistance for %s', item => {
  const expansion = expandNeed(item)
  expect(expansion.matchedKey).toBe('food')
  expect(resolveNeedExpansion(item).synonyms).toEqual([])
  expect(buildItemLikeTerms(item, expansion)).toEqual([item])
  expect(buildNeedWebQueries(item, expansion).join(' ')).not.toMatch(/SNAP|food stamps|food pantry/i)
  expect(statesEndorsingPhrase('Food bank grants and food stamps assistance', buildEndorsementPhrases(item, expansion))).toBeFalsy()
  expect(statesEndorsingPhrase(`${item} equipment grant`, buildEndorsementPhrases(item, expansion))).toBeTruthy()
})

it.each(['food assistance for a disabled individual', 'DME for a disabled individual', 'passenger van', 'food insecurity', 'legal fees', 'internet bill', 'childcare expenses', 'rent payment'])('retains relevant expansion for %s', item => {
  expect(resolveNeedExpansion(item).synonyms.length).toBeGreaterThan(0)
})
