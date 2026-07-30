import fs from 'node:fs'

const file = 'backend/services/missionHealthService.js'
let source = fs.readFileSync(file, 'utf8')

const normalizedMetric = `  const retiredBrokenDirect = normalizeCount((await safeGet(
    db,
    \`SELECT COUNT(*) AS n FROM funding_opportunities
     WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
       AND link_status = 'skipped'
       AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'\`,
  ))?.n)`

if (!source.includes(normalizedMetric)) {
  const pattern = /    const retiredBrokenDirect = normalizeCount\(\(await safeGet\(\n      db,\n      `SELECT COUNT\(\*\) AS n FROM funding_opportunities\n       WHERE COALESCE\(opportunity_kind,'direct'\) IN \$\{directKinds\}\n         AND link_status = 'skipped'\n         AND COALESCE\(verification_error, ''\) LIKE 'retired_after_definitive_recheck:%'`,\n    \)\)\?\.n\)/
  const matches = source.match(new RegExp(pattern.source, 'g')) || []
  if (matches.length !== 1) {
    throw new Error(`[scheduled-retry-prelude] retired metric anchor expected once, found ${matches.length}`)
  }
  source = source.replace(pattern, normalizedMetric)
}

const normalizedCount = '      retired_broken_direct_opportunities: retiredBrokenDirect,'
if (!source.includes(normalizedCount)) {
  const pattern = /        retired_broken_direct_opportunities: retiredBrokenDirect,/
  const matches = source.match(new RegExp(pattern.source, 'g')) || []
  if (matches.length !== 1) {
    throw new Error(`[scheduled-retry-prelude] retired count anchor expected once, found ${matches.length}`)
  }
  source = source.replace(pattern, normalizedCount)
}

fs.writeFileSync(file, source)
console.log('[source-materialization] scheduled-retry mission anchors normalized')
