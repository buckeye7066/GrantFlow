import fs from 'node:fs'

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, text) { fs.writeFileSync(file, text) }

function replaceOne(file, pattern, replacement, label) {
  const before = read(file)
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${label || file}: expected one match, found ${matches.length}`)
  }
  write(file, before.replace(pattern, replacement))
}

function insertBefore(file, marker, text, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label || file}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first) + text + before.slice(first))
}

replaceOne(
  'backend/services/missionHealthService.js',
  /function pct\(num, denom\) \{[\s\S]*?\n\}/,
  `export function normalizeCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export function pct(num, denom) {
  const numerator = Number(num)
  const denominator = Number(denom)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}`,
  'mission count helpers',
)

replaceOne(
  'backend/services/missionHealthService.js',
  /  \/\/ ── Opportunity-level metrics[\s\S]*?(?=  \/\/ ── Coverage by source)/,
  `  // ── Opportunity-level metrics ───────────────────────────────────────
  const directKinds = "('direct','benefit')"
  const directoryKinds = "('directory','referral','school_portal')"
  const visibleDirectWhere = \`
    COALESCE(opportunity_kind,'direct') IN \${directKinds}
    AND COALESCE(is_active, TRUE) = TRUE
    AND COALESCE(is_hidden, FALSE) = FALSE
  \`

  // pg returns COUNT(*) as strings. Normalize at the metric boundary.
  const catalogDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}\`,
  ))?.n)
  const totalDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities WHERE \${visibleDirectWhere}\`,
  ))?.n)
  const verifiedDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE \${visibleDirectWhere}
       AND link_status IN ('ok','redirect','verified')
       AND last_verified_at IS NOT NULL\`,
  ))?.n)
  const brokenDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE \${visibleDirectWhere}
       AND link_status = 'broken'\`,
  ))?.n)
  const quarantinedBrokenDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
       AND link_status = 'broken'
       AND (COALESCE(is_hidden, FALSE) = TRUE OR COALESCE(is_active, TRUE) = FALSE)\`,
  ))?.n)
  const totalDirectory = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'') IN \${directoryKinds}
       AND COALESCE(is_active, TRUE) = TRUE
       AND COALESCE(is_hidden, FALSE) = FALSE\`,
  ))?.n)

  const placeholderCount = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE LOWER(COALESCE(source,'')) IN ('synthetic','template','fake')
        OR LOWER(COALESCE(record_origin,'')) IN ('synthetic')
        OR LOWER(COALESCE(title,'')) LIKE '%placeholder%'
        OR LOWER(COALESCE(title,'')) LIKE '%lorem ipsum%'\`,
  ))?.n)

  const eventsSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const eventsRow = await safeGet(
    db,
    'SELECT COUNT(*) AS n FROM verification_events WHERE created_at >= ?',
    [eventsSince],
  )
  const events24h = eventsRow?.__error ? null : normalizeCount(eventsRow?.n)

`,
  'mission opportunity metrics',
)

replaceOne(
  'backend/services/missionHealthService.js',
  /  const verifiedPct = pct\(verifiedDirect, totalDirect\)\n  const brokenPct = pct\(brokenDirect, totalDirect\)/,
  `  const normalizedCoverage = Array.isArray(coverage)
    ? coverage.map((row) => ({ ...row, n: normalizeCount(row?.n) }))
    : []
  const normalizedFunnel = Array.isArray(funnel)
    ? funnel.map((row) => ({ ...row, n: normalizeCount(row?.n) }))
    : []

  const verifiedPct = pct(verifiedDirect, totalDirect)
  const brokenPct = pct(brokenDirect, totalDirect)`,
  'mission grouped count normalization',
)

replaceOne(
  'backend/services/missionHealthService.js',
  /    counts: \{[\s\S]*?      verification_events_24h: events24h,\n    \},/,
  `    counts: {
      catalog_direct_opportunities_total: catalogDirect,
      direct_opportunities_total: totalDirect,
      direct_opportunities_verified: verifiedDirect,
      direct_opportunities_broken: brokenDirect,
      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,
      directory_opportunities_total: totalDirectory,
      placeholder_opportunities: placeholderCount,
      verification_events_24h: events24h,
    },`,
  'mission response counts',
)
replaceOne(
  'backend/services/missionHealthService.js',
  /    coverage_by_source: coverage,\n    application_funnel: funnel,/,
  `    coverage_by_source: normalizedCoverage,
    application_funnel: normalizedFunnel,`,
  'mission grouped response',
)
replaceOne(
  'backend/services/missionHealthService.js',
  /export default \{ buildMissionHealth, MISSION_TARGETS: TARGETS \}/,
  'export default { buildMissionHealth, MISSION_TARGETS: TARGETS, normalizeCount, pct }',
  'mission default export',
)

replaceOne(
  'tests/mission/mission-health-dashboard.test.mjs',
  /import \{ buildMissionHealth, MISSION_TARGETS \} from '\.\.\/\.\.\/backend\/services\/missionHealthService\.js'/,
  `import {
  buildMissionHealth,
  MISSION_TARGETS,
  normalizeCount,
  pct,
} from '../../backend/services/missionHealthService.js'`,
  'mission test import',
)
replaceOne(
  'tests/mission/mission-health-dashboard.test.mjs',
  /      link_status TEXT,\n      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP/,
  `      link_status TEXT,
      last_verified_at TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
  'mission test schema',
)
replaceOne(
  'tests/mission/mission-health-dashboard.test.mjs',
  /function seedRow\(db, \{ id,[\s\S]*?\n\}/,
  `function seedRow(db, {
  id,
  title = 'Test',
  source = 'grants.gov',
  record_origin = 'live_crawl',
  kind = 'direct',
  link_status = 'verified',
  last_verified_at = new Date().toISOString(),
  is_active = 1,
  is_hidden = 0,
} = {}) {
  db.raw
    .prepare(
      \`INSERT INTO funding_opportunities
        (id, title, source, record_origin, opportunity_kind, link_status,
         last_verified_at, is_active, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
    )
    .run(id, title, source, record_origin, kind, link_status, last_verified_at, is_active, is_hidden)
}`,
  'mission seed helper',
)
insertBefore(
  'tests/mission/mission-health-dashboard.test.mjs',
  "test('mission-health: TARGETS exposes the release-gate code list'",
  `test('mission-health: PostgreSQL-shaped string counts produce real percentages', () => {
  assert.equal(normalizeCount('5678'), 5678)
  assert.equal(pct('652', '5678'), 11.5)
})

test('mission-health: canonical verifier statuses count as verified', async () => {
  const db = createDb()
  seedRow(db, { id: 'ok-1', link_status: 'ok' })
  seedRow(db, { id: 'redirect-1', link_status: 'redirect' })
  seedRow(db, { id: 'legacy-1', link_status: 'verified' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.direct_opportunities_verified, 3)
  assert.equal(h.rates.verified_pct, 100)
})

test('mission-health: quarantined broken rows do not poison visible rates', async () => {
  const db = createDb()
  seedRow(db, { id: 'ok-1', link_status: 'ok' })
  seedRow(db, { id: 'hidden', link_status: 'broken', is_hidden: 1 })
  seedRow(db, { id: 'inactive', link_status: 'broken', is_active: 0 })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.catalog_direct_opportunities_total, 3)
  assert.equal(h.counts.direct_opportunities_total, 1)
  assert.equal(h.counts.quarantined_broken_direct_opportunities, 2)
  assert.equal(h.rates.verified_pct, 100)
  assert.equal(h.rates.broken_pct, 0)
})

`,
  'mission PostgreSQL regression tests',
)

replaceOne(
  'backend/crawler-os/safeUrl.js',
  /\/\/ 172\.16\.0\.0[\s\S]*?\n\}/,
  `function isBlockedIpv4Literal(host) {
  const octets = String(host).split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && (b === 0 || b === 168)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}`,
  'IPv4 reserved ranges',
)
replaceOne(
  'backend/crawler-os/safeUrl.js',
  /  if \(isPrivate172\(h\)\) return true;\n  if \(isBlockedIpLiteral\(h\)\) return true;/,
  '  if (isBlockedIpLiteral(h)) return true;',
  'remove legacy 172 helper',
)
replaceOne(
  'backend/crawler-os/safeUrl.js',
  /  if \(ipVersion === 4\) return false;[^\n]*/,
  '  if (ipVersion === 4) return isBlockedIpv4Literal(host);',
  'IPv4 literal validator',
)
replaceOne(
  'backend/crawler-os/safeUrl.js',
  /  if \(\(head & 0xffc0\) === 0xfec0\) return true;([^\n]*)\n  return false;/,
  `  if ((head & 0xffc0) === 0xfec0) return true;$1
  if ((head & 0xff00) === 0xff00) return true;         // ff00::/8 multicast
  return false;`,
  'IPv6 multicast',
)
replaceOne(
  'backend/crawler-os/fetcher.js',
  /  const resolve = typeof opts\.resolve === 'function' \? opts\.resolve : \(\(host\) => dns\.promises\.resolve\(host\)\);/,
  `  const resolve = typeof opts.resolve === 'function'
    ? opts.resolve
    : async (host) => {
        const records = await dns.promises.lookup(host, { all: true, verbatim: true })
        return records.map((record) => record.address)
      };`,
  'DNS A+AAAA resolution',
)
replaceOne(
  'backend/crawler-os/tests/fetcher.test.mjs',
  /\['203\.0\.113\.10'\]/g,
  "['8.8.8.8']",
  'fetcher public fixture',
)

insertBefore(
  'backend/routes/ai.js',
  "import { TIER_CAPABILITIES } from '../utils/tierGating.js'",
  "import { fetchPublicText } from '../utils/safeRemoteFetch.js'\n",
  'AI safe fetch import',
)
replaceOne(
  'backend/routes/ai.js',
  /    \/\/ Fetch portal page content if URL given and no content provided[\s\S]*?(?=\n    const questionsText)/,
  `    // Fetch untrusted portal content through the canonical SSRF-safe reader.
    let portalContent = page_content || ''
    if (!portalContent && portal_url) {
      const remote = await fetchPublicText(portal_url, {
        timeoutMs: 15_000,
        maxBytes: 256_000,
        userAgent: 'GrantFlow Application Assistant/1.0',
      })
      if (remote.ok) {
        portalContent = remote.body
          .replace(/<script[\\s\\S]*?<\\/script>/gi, '')
          .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\\s{2,}/g, ' ')
          .slice(0, 12000)
      } else {
        routeLogger.warn('[portal-assist] remote portal read refused or failed', {
          reason: remote.reason || remote.error || 'remote_fetch_failed',
          status: remote.status ?? null,
        })
      }
    }
`,
  'portal assistant fetch',
)

replaceOne(
  'backend/start.js',
  /function runMigrationsInBackground\(\) \{[\s\S]*?\n\}\n\n(?=function maybeRunSqliteToPostgresMigrationInBackground)/,
  '',
  'duplicate migration function',
)
replaceOne(
  'backend/start.js',
  /\/\/ Run migrations in background after boot[\s\S]*?runMigrationsInBackground\(\)\n\n/,
  `// Schema migrations have exactly one owner: server.js runs the canonical
// boot-policy-controlled migration pass before readiness.

`,
  'duplicate migration call',
)

insertBefore(
  'backend/middleware/pipelineMonitor.js',
  '/**\n * Lightweight production monitoring',
  "import { apiRateLimitMiddleware } from './apiRateLimitPolicy.js'\n\n",
  'rate-limit import',
)
replaceOne(
  'backend/middleware/pipelineMonitor.js',
  /export function pipelineMonitor\(\) \{\n  return function monitor\(req, res, next\) \{\n    const group = classifyPath\(req\.path\)\n    if \(!group\) return next\(\)/,
  `export function pipelineMonitor() {
  const limitRequest = apiRateLimitMiddleware()

  return function monitor(req, res, next) {
    return limitRequest(req, res, () => {
      const group = classifyPath(req.path)
      if (!group) return next()`,
  'rate-limit middleware start',
)
replaceOne(
  'backend/middleware/pipelineMonitor.js',
  /    next\(\)\n  \}\n\}\n\nexport function getPipelineHealth/,
  `      next()
    })
  }
}

export function getPipelineHealth`,
  'rate-limit middleware end',
)

replaceOne(
  'backend/routes/admin.js',
  /const result = seedAssistanceDirectories\(req\.db\);/,
  'const result = await seedAssistanceDirectories(req.db);',
  'await assistance directory seed',
)

const ai = read('backend/routes/ai.js')
if (/fetch\(portal_url/.test(ai)) throw new Error('direct portal_url fetch remains')
if (!ai.includes('fetchPublicText(portal_url')) throw new Error('safe portal fetch not wired')
console.log('[global-hardening] code transformations applied')
