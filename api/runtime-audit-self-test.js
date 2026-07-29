import { AnyaChatErrorBoundary } from '../src/components/anya/SafeAnyaChat.jsx'
import { repairLegacyPublicAwardClaims } from '../backend/utils/ensurePortalCheckResultsTable.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fakeDb({ rows, sectionData = null }) {
  const writes = []
  return {
    writes,
    prepare(sql) {
      if (sql.includes('FROM portal_check_results')) {
        return { async all() { return rows } }
      }
      if (sql.includes('FROM profile_sections')) {
        return {
          async get() {
            return sectionData ? { data: JSON.stringify(sectionData) } : null
          },
        }
      }
      if (sql.startsWith('UPDATE portal_check_results')) {
        return {
          async run(resultsJson, id) {
            writes.push({ id, resultsJson: JSON.parse(resultsJson) })
            return { changes: 1 }
          },
        }
      }
      throw new Error(`unexpected SQL in runtime self-test: ${sql}`)
    },
  }
}

async function runTests() {
  const tests = []
  const test = async (name, fn) => {
    await fn()
    tests.push({ name, ok: true })
  }

  await test('Anya boundary exposes React error recovery', () => {
    assert(typeof AnyaChatErrorBoundary.getDerivedStateFromError === 'function', 'missing error boundary static handler')
    assert(typeof AnyaChatErrorBoundary.prototype.componentDidCatch === 'function', 'missing error logger')
    assert(typeof AnyaChatErrorBoundary.prototype.handleRetry === 'function', 'missing in-place retry')
    const state = AnyaChatErrorBoundary.getDerivedStateFromError(new Error('synthetic'))
    assert(state?.failed === true, 'boundary did not enter fallback state')
  })

  await test('public portal claims become advertising evidence, not personal awards', async () => {
    const db = fakeDb({
      rows: [{
        id: 'public-1',
        profile_id: 'profile-1',
        portal_name: 'Public portal',
        portal_url: 'https://example.test/aid',
        awards_detected: 274,
        results_json: JSON.stringify({
          portalName: 'Public portal',
          portalUrl: 'https://example.test/aid',
          updateType: 'scholarship_award',
          awardName: 'Advertised award',
          awardAmount: 5000,
          awardAmountRaw: '$5,000',
        }),
      }],
    })
    assert(await repairLegacyPublicAwardClaims(db) === 1, 'expected one repaired public claim')
    const written = db.writes[0]?.resultsJson
    assert(written?.updateType === null, 'public claim kept a personal-award status')
    assert(written?.awardName === null, 'public claim kept a personal award name')
    assert(written?.publicSignals?.advertised_amount === 5000, 'advertised amount evidence was lost')
  })

  await test('owner-persisted awards survive the portal reconciliation', async () => {
    const db = fakeDb({
      rows: [{
        id: 'owner-1',
        profile_id: 'profile-1',
        portal_name: 'TSAC Portal',
        portal_url: 'https://example.test/aid',
        awards_detected: 9,
        results_json: JSON.stringify({
          applicationId: 'app-1',
          portalName: 'TSAC Portal',
          portalUrl: 'https://example.test/aid',
          updateType: 'scholarship_award',
          awardName: 'Confirmed award',
          awardAmount: 2500,
          awardAmountRaw: '$2,500',
        }),
      }],
      sectionData: {
        applications: [{
          id: 'app-1',
          imported_portal_awards: [{
            portal_name: 'TSAC Portal',
            portal_url: 'https://example.test/aid',
            award_name: 'Confirmed award',
            award_amount: 2500,
            award_amount_raw: '$2,500',
          }],
        }],
      },
    })
    assert(await repairLegacyPublicAwardClaims(db) === 1, 'expected one reconciled owner claim')
    const written = db.writes[0]?.resultsJson
    assert(written?.updateType === 'owner_merged_award', 'owner evidence was not distinguished')
    assert(written?.awardName === 'Confirmed award', 'owner award name was lost')
    assert(written?.awardAmount === 2500, 'owner award amount was lost')
  })

  return tests
}

export default async function handler(_request, response) {
  try {
    const tests = await runTests()
    response.status(200).json({ ok: true, test_count: tests.length, tests })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error?.message || String(error),
      stack: String(error?.stack || '').split('\n').slice(0, 6),
    })
  }
}
