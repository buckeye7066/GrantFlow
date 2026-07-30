import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (file) => fs.readFileSync(file, 'utf8')

test('post-crawl and boot choke points permanently enforce persisted match integrity', () => {
  const service = read('backend/services/matching/matchDecisionIntegrity.js')
  const persistence = read('backend/services/crawlerOsPersistence.js')
  const crawler = read('backend/services/crawlerOsService.js')
  const needFirst = read('backend/services/matching/needFirstReconciler.js')
  const invariants = read('backend/startup/enforceInvariants.js')
  const materializer = read('scripts/materialize-production-source.mjs')

  assert.match(service, /removed_canonical_rejects/)
  assert.match(service, /SURFACED_MATCHER_VERSIONS_SQL/)
  assert.match(persistence, /normalizePersistedMatchDecisionIntegrity/)
  assert.match(crawler, /post_crawl_match_decision_integrity/)
  assert.match(crawler, /normalizePersistedMatchDecisionIntegrity\(db, \{ profileId \}\)/)
  assert.match(needFirst, /match_decision_integrity: matchDecisionIntegrity/)
  assert.match(invariants, /export async function enforcePersistedMatchDecisionIntegrity/)
  assert.match(invariants, /steps\.push\(await enforcePersistedMatchDecisionIntegrity\(db\)\)/)
  assert.match(materializer, /apply-match-decision-integrity\.mjs/)
})
