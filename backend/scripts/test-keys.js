#!/usr/bin/env node
/**
 * Quick connectivity tests for Funding API keys.
 *
 * Constraints:
 * - Never prints secret values
 * - Cleanly reports missing keys
 * - Exits nonzero if any REQUIRED provider key is missing or if any checks fail
 */

import { fetchOpportunities as fetchGrantsGov } from '../src/integrations/grantsGov.js'
import { fetchOpportunities as fetchSimpler } from '../src/integrations/simplerGrants.js'
import { fetchOpportunities as fetchSam } from '../src/integrations/samGov.js'
import { fetchOpportunities as fetchNih } from '../src/integrations/nihReporter.js'
import { loadFundingApiKeys, getFundingApiKeyPresence } from '../src/config/apiKeys.js'
import { requestJson } from '../src/integrations/httpClient.js'

const REQUIRED_KEYS = ['SIMPLER_GRANTS_API_KEY', 'SAM_GOV_PUBLIC_API_KEY']

function print(line) {
  console.log(line)
}

function printErr(line) {
  console.error(line)
}

async function runCheck(name, fn) {
  const started = Date.now()
  try {
    await fn()
    const ms = Date.now() - started
    print(`PASS  ${name} (${ms}ms)`)
    return { ok: true }
  } catch (err) {
    const ms = Date.now() - started
    const msg = err?.message ? String(err.message) : String(err)
    printErr(`FAIL  ${name} (${ms}ms) :: ${msg}`)
    return { ok: false, error: msg }
  }
}

async function main() {
  print('GrantFlow Funding API Key Checks')
  print('--------------------------------')

  const keys = loadFundingApiKeys()
  const presence = getFundingApiKeyPresence()

  print('Key presence (values never printed):')
  for (const [k, v] of Object.entries(presence)) {
    print(`- ${k}: ${v ? 'present' : 'missing'}`)
  }
  print('')

  const missingRequired = REQUIRED_KEYS.filter((k) => !keys[k])
  if (missingRequired.length > 0) {
    printErr(
      `Missing required keys: ${missingRequired.join(', ')}\n` +
        `Set them in local .env / Railway / Vercel secrets, then rerun.`,
    )
  }

  const results = []

  // Grants.gov: should work even without key (public search endpoint)
  results.push(
    await runCheck('Grants.gov (public search)', async () => {
      const rows = await fetchGrantsGov({ rows: 1, startRecordNum: 0, oppStatuses: 'posted' })
      if (!Array.isArray(rows)) throw new Error('Unexpected response shape (not an array)')
    }),
  )

  // Simpler.Grants.gov: requires key
  results.push(
    await runCheck('Simpler.Grants.gov (opportunity search)', async () => {
      const rows = await fetchSimpler({ query: 'health', pageOffset: 1, pageSize: 1 })
      if (!Array.isArray(rows)) throw new Error('Unexpected response shape (not an array)')
    }),
  )

  // SAM.gov: requires key (postedFrom/postedTo required)
  results.push(
    await runCheck('SAM.gov (opportunities search)', async () => {
      const rows = await fetchSam({ keyword: 'research', limit: 1, offset: 0 })
      if (!Array.isArray(rows)) throw new Error('Unexpected response shape (not an array)')
    }),
  )

  // api.data.gov: optional; validate via an api.data.gov-backed API (govinfo) if key present
  if (keys.API_DATA_GOV_KEY) {
    results.push(
      await runCheck('api.data.gov (govinfo sample)', async () => {
        // govinfo is a real api.data.gov-backed API; any valid key should work.
        await requestJson({
          provider: 'api.data.gov',
          url: 'https://api.govinfo.gov/packages/FR-2018-08-03/summary',
          method: 'GET',
          params: { api_key: keys.API_DATA_GOV_KEY },
          timeoutMs: 20_000,
          maxRetries: 2,
        })
      }),
    )
  } else {
    print('SKIP  api.data.gov (no API_DATA_GOV_KEY set)')
  }

  // NIH RePORTER: no key required
  results.push(
    await runCheck('NIH RePORTER (projects search)', async () => {
      const rows = await fetchNih({ text: 'cancer', limit: 1, offset: 0 })
      if (!Array.isArray(rows)) throw new Error('Unexpected response shape (not an array)')
    }),
  )

  const anyFailures = results.some((r) => r.ok === false)
  const shouldFail = anyFailures || missingRequired.length > 0

  print('')
  if (shouldFail) {
    printErr('One or more checks failed (or required keys are missing).')
    process.exit(1)
  }

  print('All checks passed.')
  process.exit(0)
}

await main()

