import { describe, expect, it } from 'vitest'

import {
  CRAWLER_REQUEST_TYPES,
  PROFILE_PLANNED_CRAWLER_ALIASES,
  resolveCrawlerActivation,
} from '../config/crawlerActivationPolicy.js'

describe('crawlerActivationPolicy', () => {
  it('routes every legacy funding label to the profile-aware planner', () => {
    for (const type of PROFILE_PLANNED_CRAWLER_ALIASES) {
      expect(resolveCrawlerActivation(type)).toMatchObject({
        valid: true,
        mode: 'profile_planned',
        activation_authority: 'crawler-os/planner',
        only_source_ids: null,
      })
    }
  })

  it('keeps item search separate and rejects unknown rival engines', () => {
    expect(resolveCrawlerActivation('item_matching')).toMatchObject({
      valid: true,
      mode: 'item_search',
      activation_authority: 'itemNeedSearch',
    })
    expect(resolveCrawlerActivation('comprehensiveCrawlerOptimized')).toMatchObject({
      valid: false,
      activation_authority: 'crawler-os/planner',
    })
    expect(CRAWLER_REQUEST_TYPES).not.toContain('comprehensiveCrawlerOptimized')
  })
})
