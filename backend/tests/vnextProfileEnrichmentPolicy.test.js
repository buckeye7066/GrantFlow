import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/profileHelpers.js', () => ({
  loadProfileContext: vi.fn(async () => ({
    profile: { display_name: 'Test profile' },
    sections: {},
    signals: {},
    organization: null,
  })),
}))

vi.mock('../utils/scopedOpportunity.js', () => ({
  getScopedOpportunityForVnextApplication: vi.fn(async () => ({
    application: {
      id: 'app-1',
      profile_id: 'profile-1',
      opportunity_id: 'opp-1',
      missing_requirements: null,
      score_breakdown: null,
    },
    opportunity: {
      id: 'opp-1',
      schema_id: 'schema-1',
      title: 'Test opportunity',
      description: 'Community support',
    },
  })),
}))

vi.mock('../vnext/schemaService.js', () => ({
  getFormSchema: vi.fn(async () => ({
    id: 'schema-1',
    fields: [],
    validation_rules: { required_docs: [] },
  })),
}))

vi.mock('../vnext/auditEventsService.js', () => ({
  writeAuditEvent: vi.fn(async () => ({ ok: true })),
}))

import { loadProfileContext } from '../services/profileHelpers.js'
import { computeMissingRequirements } from '../vnext/missingnessService.js'
import { scoreApplication } from '../vnext/scoringService.js'

function makeDb() {
  return {
    dialect: 'sqlite',
    prepare: vi.fn(() => ({
      all: vi.fn(async () => []),
      run: vi.fn(async () => ({ changes: 1 })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('VNext profile enrichment policy', () => {
  it('keeps website-purpose enrichment for standalone missingness and scoring', async () => {
    const db = makeDb()

    await expect(computeMissingRequirements(db, { applicationId: 'app-1' }))
      .resolves.toMatchObject({ ok: true })
    await expect(scoreApplication(db, { applicationId: 'app-1' }))
      .resolves.toMatchObject({ ok: true })

    expect(loadProfileContext).toHaveBeenNthCalledWith(
      1,
      db,
      'profile-1',
      { enrichWebsitePurpose: true },
    )
    expect(loadProfileContext).toHaveBeenNthCalledWith(
      2,
      db,
      'profile-1',
      { enrichWebsitePurpose: true },
    )
  })

  it('honors an explicit enrichment opt-out for transaction-bound callers', async () => {
    const db = makeDb()

    await computeMissingRequirements(db, {
      applicationId: 'app-1',
      enrichWebsitePurpose: false,
    })
    await scoreApplication(db, {
      applicationId: 'app-1',
      enrichWebsitePurpose: false,
    })

    expect(loadProfileContext).toHaveBeenNthCalledWith(
      1,
      db,
      'profile-1',
      { enrichWebsitePurpose: false },
    )
    expect(loadProfileContext).toHaveBeenNthCalledWith(
      2,
      db,
      'profile-1',
      { enrichWebsitePurpose: false },
    )
  })
})
