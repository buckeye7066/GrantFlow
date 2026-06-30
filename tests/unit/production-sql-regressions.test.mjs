import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function readRepoFile(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

test('project readiness document loading avoids SELECT DISTINCT over document payload columns', () => {
  const src = readRepoFile('backend/routes/profiles.js')
  assert.doesNotMatch(
    src,
    /SELECT DISTINCT d\.id/,
    'Postgres can fail DISTINCT over JSON/document payload columns; load direct and linked docs separately instead',
  )
  assert.match(src, /WHERE d\.profile_id = \?/, 'direct profile documents must still be loaded')
  assert.match(src, /JOIN profile_documents pd ON pd\.document_id = d\.id/, 'linked profile documents must still be loaded')
})

test('login announcements use a dialect-specific boolean predicate', () => {
  const src = readRepoFile('backend/routes/announcements.js')
  // Postgres: `active` has drifted to INTEGER on some prod instances, so a bare
  // `active IS TRUE` throws "argument of IS TRUE must be type boolean". The
  // canonical predicate CASTs first (PR#701) so it holds for boolean OR integer
  // columns. Accept the CAST form (and tolerate the older bare form).
  assert.match(src, /activePredicate\s*=\s*req\.db\?\.dialect === 'postgres' \? '(?:CAST\(active AS BOOLEAN\) IS TRUE|active IS TRUE)' : 'active = 1'/)
  assert.doesNotMatch(
    src,
    /WHERE\s+active\s*=\s*1/,
    'Postgres boolean columns must not be compared to integer 1',
  )
})

test('auth bootstrap does not order a SELECT DISTINCT result by an unselected column', () => {
  const src = readRepoFile('backend/server.js')
  const query = src.match(/SELECT DISTINCT p\.id, p\.display_name, p\.organization_id, p\.status[\s\S]+?ORDER BY p\.[a-z_]+ ASC/)?.[0] || ''
  const selectList = query.split('FROM profiles p')[0] || ''
  assert.ok(query, 'auth bootstrap DISTINCT profile query should be present')
  assert.match(selectList, /p\.created_at/, 'Postgres requires ORDER BY columns in SELECT DISTINCT list')
})

test('from-opportunity manual profile saves stop when the canonical pipeline gate declines', () => {
  const src = readRepoFile('backend/routes/grants.js')
  assert.match(
    src,
    /pipeline_gate_failed/,
    'manual from-opportunity saves must return a gate response instead of silently inserting weak profile matches',
  )
  assert.doesNotMatch(
    src,
    /canonical saver declined manual add; falling back to self-healing insert path/,
    'canonical gate declines must not fall through to the legacy insert path',
  )
  assert.match(
    src,
    /pipelineResult\?\.gate !== 'DISMISSED'/,
    'only the intentional sticky-delete restore path may continue past a canonical declined save',
  )
})

test('web_search leads cannot bypass catalog quality gates into profile pipeline saves', () => {
  const src = readRepoFile('backend/routes/grants.js')
  assert.match(src, /web_lead_rejected/, 'gated web leads should return an explicit rejection')
  assert.match(src, /web_lead_persistence_failed/, 'web lead persistence failures should not fall through')
  assert.doesNotMatch(
    src,
    /web lead (?:not persisted|persistence failed).*saving inline/is,
    'web_search leads rejected by catalog gates must not be saved inline into a profile pipeline',
  )
})

test('real crawler compatibility routes are backed by Crawler OS, not legacy no-op helpers', () => {
  const src = readRepoFile('backend/routes/realCrawlers.js')
  const specificNeedRoute = src.match(/router\.post\('\/specific-need'[\s\S]+?router\.get\('\/strategies'/)?.[0] || ''
  const smartRoute = src.match(/router\.post\('\/run-smart'[\s\S]+?router\.post\('\/run-housing'/)?.[0] || ''
  assert.ok(specificNeedRoute, 'specific-need route should be present')
  assert.ok(smartRoute, 'run-smart route should be present')
  for (const routeSource of [specificNeedRoute, smartRoute]) {
    assert.match(routeSource, /engine:\s*'crawler-os'/, 'compatibility route responses should identify the OS engine')
    assert.doesNotMatch(routeSource, /runCrawler\(/, 'compatibility routes must not call the superseded crawler framework')
    assert.doesNotMatch(routeSource, /searchWebForItem|parseItemRequest|KNOWN_ITEM_SOURCES/, 'specific item search must not use legacy no-op item helpers')
    assert.doesNotMatch(routeSource, /runAllDomainEngines|crawlStateWaiverBenefits|evaluateStateWaiverEligibility/, 'smart search must not call superseded domain/waiver helpers')
  }
})

test('route handlers use the cross-database prepare adapter instead of raw db.query', () => {
  const routePaths = [
    'backend/routes/contacts.js',
    'backend/routes/colleges.js',
    'backend/routes/vehicles.js',
  ]

  for (const routePath of routePaths) {
    const src = readRepoFile(routePath)
    assert.doesNotMatch(
      src,
      /\bdb\.query\s*\(/,
      `${routePath} must use prepare().get/all/run so SQLite and Postgres behave the same`,
    )
  }
})

test('unique preference and portal-status writes are conflict-safe', () => {
  const preferences = readRepoFile('backend/routes/preferences.js')
  const billingSettings = readRepoFile('backend/routes/billingSettings.js')
  const portalStore = readRepoFile('backend/services/hamilton/portalCompletionStore.js')

  assert.match(preferences, /ON CONFLICT\(user_id\) DO NOTHING/, 'preferences first-write path must tolerate user_id races')
  assert.match(billingSettings, /ON CONFLICT\(user_id\) DO NOTHING/, 'billing settings first-write path must tolerate user_id races')
  assert.match(
    portalStore,
    /ON CONFLICT\(profile_id, portal_host\) DO UPDATE SET/,
    'portal status writes must tolerate profile/host races',
  )
})

test('central error handler captures production exceptions through observability hook', () => {
  const errorHandler = readRepoFile('backend/middleware/errorHandler.js')
  const observability = readRepoFile('backend/utils/observability.js')

  assert.match(errorHandler, /captureException\(err,/, 'central error handler should capture delegated route exceptions')
  assert.match(observability, /SENTRY_DSN/, 'observability must be gated by SENTRY_DSN')
  assert.doesNotMatch(observability, /req\.body|request\.body/, 'observability must not capture request bodies')
})
