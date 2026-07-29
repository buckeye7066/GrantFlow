import test from 'node:test'
import assert from 'node:assert/strict'

import { __resetAxiosForTests, __setAxiosForTests } from '../../backend/src/integrations/httpClient.js'
import { fetchOpportunities as fetchSam } from '../../backend/src/integrations/samGov.js'
import { fetchOpportunities as fetchSimpler } from '../../backend/src/integrations/simplerGrants.js'
import { fetchOpportunities as fetchGrantsGov } from '../../backend/src/integrations/grantsGov.js'
import { fetchOpportunities as fetchNih } from '../../backend/src/integrations/nihReporter.js'
import { fetchGovInfoPackageSummary } from '../../backend/src/integrations/apiDataGov.js'
import { searchEntitiesByUei as searchSamEntitiesByUei } from '../../backend/src/integrations/samGovEntity.js'

async function withEnv(vars, fn) {
  const originals = {}
  for (const key of Object.keys(vars)) originals[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) delete process.env[key]
    else process.env[key] = String(value)
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('funding clients: required keys throw deterministic MISSING_API_KEY', async () => {
  await withEnv(
    {
      SIMPLER_GRANTS_API_KEY: null,
      SAM_GOV_PUBLIC_API_KEY: null,
      SAM_GOV_API_KEY: null,
      SAM_GOV_KEY: null,
      Sam_gov_key: null,
      API_DATA_GOV_KEY: null,
    },
    async () => {
      await assert.rejects(() => fetchSimpler({ query: 'x', pageOffset: 1, pageSize: 1 }), (error) => {
        assert.equal(error.code, 'MISSING_API_KEY')
        return true
      })

      await assert.rejects(() => fetchSam({ keyword: 'x', limit: 1, offset: 0 }), (error) => {
        assert.equal(error.code, 'MISSING_API_KEY')
        return true
      })

      await assert.rejects(() => searchSamEntitiesByUei({ uei: 'SAMPLEUEI123456', limit: 1 }), (error) => {
        assert.equal(error.code, 'MISSING_API_KEY')
        return true
      })

      await assert.rejects(() => fetchGovInfoPackageSummary('FR-2018-08-03'), (error) => {
        assert.equal(error.code, 'MISSING_API_KEY')
        return true
      })
    },
  )
})

test('funding clients: normalize responses (no real network)', async () => {
  /** @type {Array<any>} */
  const calls = []

  __setAxiosForTests(async (config) => {
    calls.push(config)
    const url = String(config?.url || '')

    if (url.includes('api.simpler.grants.gov')) {
      return {
        status: 200,
        headers: {},
        data: {
          opportunities: [
            {
              opportunity_id: 'simp-1',
              opportunity_title: 'Simpler Test Opp',
              agency_name: 'Test Agency',
              close_date: '2026-12-31',
            },
          ],
        },
      }
    }

    if (url.includes('api.sam.gov/opportunities/v2/search')) {
      return {
        status: 200,
        headers: {},
        data: {
          opportunitiesData: [
            {
              noticeId: 'sam-1',
              title: 'SAM Test Opp',
              deptName: 'GSA',
              uiLink: 'https://example.org/sam/1',
            },
          ],
        },
      }
    }

    if (url.includes('api.sam.gov/entity-information/v4/entities')) {
      return {
        status: 200,
        headers: {},
        data: {
          entityData: [
            {
              ueiSAM: 'TESTUEI123456',
              legalBusinessName: 'Test Entity LLC',
            },
          ],
        },
      }
    }

    if (url.includes('api.grants.gov/v1/api/search2')) {
      return {
        status: 200,
        headers: {},
        data: {
          oppHits: [
            {
              number: 'gg-1',
              title: 'Grants.gov Test Opp',
              agencyName: 'NIH',
              closeDate: '2026-11-30',
            },
          ],
        },
      }
    }

    if (url.includes('api.reporter.nih.gov/v2/projects/search')) {
      return {
        status: 200,
        headers: {},
        data: {
          results: [
            {
              project_num: 'nih-1',
              project_title: 'NIH Project',
              agency_ic_admin: 'NCI',
              org_name: 'Test University',
              project_detail_url: 'https://example.org/nih/1',
              award_amount: 12345,
            },
          ],
        },
      }
    }

    if (url.includes('api.govinfo.gov/packages/')) {
      return { status: 200, headers: {}, data: { ok: true, package: url } }
    }

    return { status: 404, headers: {}, data: { error: 'unexpected url', url } }
  })

  try {
    await withEnv(
      {
        SIMPLER_GRANTS_API_KEY: 'test-simpler',
        SAM_GOV_PUBLIC_API_KEY: 'test-sam',
        API_DATA_GOV_KEY: 'test-data-gov',
        // Grants.gov key is optional; omit to ensure it stays optional.
        GRANTS_GOV_API_KEY: null,
      },
      async () => {
        const simplerResult = await fetchSimpler({ query: 'health', pageOffset: 1, pageSize: 1 })
        assert.equal(simplerResult.opportunities[0].source, 'simpler.grants.gov')
        assert.equal(simplerResult.opportunities[0].source_id, 'simp-1')

        const sam = await fetchSam({ keyword: 'research', limit: 1, offset: 0 })
        assert.equal(sam[0].source, 'sam.gov')
        assert.equal(sam[0].source_id, 'sam-1')

        const samEntity = await searchSamEntitiesByUei({ uei: 'TESTUEI123456', limit: 1, offset: 0 })
        assert.ok(Array.isArray(samEntity.entities))
        assert.equal(samEntity.entities[0].ueiSAM, 'TESTUEI123456')

        const grantsGov = await fetchGrantsGov({ keyword: 'health', rows: 1, startRecordNum: 0 })
        assert.equal(grantsGov[0].source, 'grants.gov')
        assert.equal(grantsGov[0].source_id, 'gg-1')

        const nih = await fetchNih({ text: 'cancer', limit: 1, offset: 0 })
        assert.equal(nih[0].source, 'nih.reporter')
        assert.equal(nih[0].source_id, 'nih-1')

        const govinfo = await fetchGovInfoPackageSummary('FR-2018-08-03')
        assert.equal(govinfo.ok, true)
      },
    )

    // Sanity: ensure we actually mocked outbound calls.
    assert.ok(calls.length >= 5)
  } finally {
    __resetAxiosForTests()
  }
})
