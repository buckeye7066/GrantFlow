import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function replaceOnce(file, pattern, replacement, label) {
  const before = read(file)
  const matches = before.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) || []
  if (matches.length !== 1) throw new Error(`${label}: expected one match, found ${matches.length}`)
  write(file, before.replace(pattern, replacement))
}

function insertAfter(file, marker, addition, label) {
  const before = read(file)
  const first = before.indexOf(marker)
  if (first < 0 || before.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`${label}: marker missing or ambiguous`)
  }
  write(file, before.slice(0, first + marker.length) + addition + before.slice(first + marker.length))
}

const signatures = [
  ['backend/services/crawlers/nationalZipCrawler.js', 'link_backlog_resource_contract'],
  ['backend/services/linkVerificationService.js', 'browser-compatible liveness probe'],
  ['backend/server.js', "app.use('/api/admin/link-repair'"],
  ['backend/server.js', '[link-repair] recurring lifecycle pass'],
  ['backend/services/missionHealthService.js', 'repair_pending_broken_direct_opportunities'],
]

const alreadyPresent = signatures.every(([file, signature]) => read(file).includes(signature))
if (alreadyPresent) {
  // This module is imported by the parent materializer. Never call process.exit()
  // here: doing so would prevent later permanent correction modules and final
  // signature verification from running on repeated npm lifecycle hooks.
  console.log('[source-materialization] link backlog lifecycle repair already present')
} else {
  if (signatures.some(([file, signature]) => read(file).includes(signature))) {
    throw new Error('[source-materialization] partial link backlog lifecycle repair detected')
  }

  replaceOnce(
    'backend/services/crawlers/nationalZipCrawler.js',
    /  const url = pickFirstUrl\([\s\S]*?\n  \)\n  if \(!url\) return null/,
    `  const contactUrl = pickFirstUrl(
      tags.website,
      tags['contact:website'],
      tags.url,
      tags['contact:url'],
      tags['contact:facebook'],
      tags.facebook,
      tags['contact:instagram'],
      tags.instagram,
    )
    // link_backlog_resource_contract: Overpass rows are local resource pointers,
    // never direct funding. The OSM element page is the stable evidence target;
    // an organization website remains optional contact metadata.
    const osmType = ['node', 'way', 'relation'].includes(String(element?.type || '').toLowerCase())
      ? String(element.type).toLowerCase()
      : null
    const osmId = /^\\d+$/.test(String(element?.id || '')) ? String(element.id) : null
    const url = osmType && osmId ? \`https://www.openstreetmap.org/\${osmType}/\${osmId}\` : null
    if (!url) return null`,
    'Overpass stable-resource URL',
  )
  replaceOnce(
    'backend/services/crawlers/nationalZipCrawler.js',
    /    opportunity_type: 'benefit',\n    type: 'PROGRAM',/,
    `    opportunity_kind: 'directory',
      result_kind: 'directory',
      opportunity_type: 'directory',
      type: 'DIRECTORY',
      record_origin: 'directory_resource',
      source_trust_tier: 'community_directory',
      contact_info: contactUrl ? { website: contactUrl } : null,`,
    'Overpass resource classification',
  )

  replaceOnce(
    'backend/services/linkVerificationService.js',
    /        headers: \{\n          'User-Agent': 'GrantFlow-LinkChecker\/1\.0 \(contact: support@grantflow\.app\)',\n        \},/,
    `        headers: {
            // browser-compatible liveness probe: transparent product token plus
            // normal document headers avoids false 403/404 results from servers
            // that reject bare programmatic HEAD requests.
            'User-Agent': 'Mozilla/5.0 (compatible; GrantFlowLinkVerifier/2.0; +https://app.axiombiolabs.org)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },`,
    'Verifier request headers',
  )
  replaceOnce(
    'backend/services/linkVerificationService.js',
    /  if \(outcome\.code === 405 \|\| outcome\.code === 403 \|\| outcome\.code === 501\) \{/,
    `  if (outcome.code === null || outcome.code < 200 || outcome.code >= 400) {`,
    'HEAD-to-GET fallback',
  )
  replaceOnce(
    'backend/services/linkVerificationService.js',
    /        WHERE \(application_url IS NOT NULL OR source_url IS NOT NULL\)\n          AND \(last_verified_at IS NULL OR last_verified_at < \?\)\n        ORDER BY \(last_verified_at IS NULL\) DESC, last_verified_at ASC/,
    `        WHERE (application_url IS NOT NULL OR source_url IS NOT NULL)
            AND NOT (
              link_status = 'skipped'
              AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'
            )
            AND (link_status = 'broken' OR last_verified_at IS NULL OR last_verified_at < ?)
          ORDER BY CASE WHEN link_status = 'broken' THEN 0 ELSE 1 END,
                   (last_verified_at IS NULL) DESC, last_verified_at ASC`,
    'Broken-link priority selection',
  )
  replaceOnce(
    'backend/services/linkVerificationService.js',
    /  const hide = db\.prepare\(`\n    UPDATE funding_opportunities\n    SET is_hidden = 1\n    WHERE id = \?\n  `\)/,
    `  const hide = db.prepare(\`
      UPDATE funding_opportunities
      SET is_hidden = ?
      WHERE id = ?
    \`)`,
    'Postgres-safe hide SQL',
  )
  replaceOnce(
    'backend/services/linkVerificationService.js',
    /            await hide\.run\(row\.id\)/,
    `            await hide.run(isPostgres ? true : 1, row.id)`,
    'Postgres-safe hide call',
  )

  insertAfter(
    'backend/server.js',
    "app.use('/api/admin/queue', adminQueueOpsRouter)",
    "\napp.use('/api/admin/link-repair', lazyRouter('./routes/linkBacklogRepair.js'))",
    'Link repair route mount',
  )
  replaceOnce(
    'backend/server.js',
    /        console\.log\('\[link-verify\] completed:', stats\)/,
    `        console.log('[link-verify] completed:', stats)
          const { repairBrokenDirectBatch } = await import('./services/linkBacklogRepairService.js')
          const lifecycle = await repairBrokenDirectBatch(dbInstance, {
            limit: Math.min(100, limit),
            concurrency: 8,
            timeoutMs: 10_000,
            verifiedBy: \`recurring-link-repair:pid=\${process.pid}\`,
          })
          console.log('[link-repair] recurring lifecycle pass:', lifecycle)`,
    'Recurring link lifecycle pass',
  )

  replaceOnce(
    'backend/services/missionHealthService.js',
    /  const quarantinedBrokenDirect = normalizeCount\(\(await safeGet\(\n    db,\n    `SELECT COUNT\(\*\) AS n FROM funding_opportunities\n     WHERE COALESCE\(opportunity_kind,'direct'\) IN \$\{directKinds\}\n       AND link_status = 'broken'\n       AND \(COALESCE\(is_hidden, FALSE\) = TRUE OR COALESCE\(is_active, TRUE\) = FALSE\)`,\n  \)\)\?\.n\)/,
    `  const quarantinedBrokenDirect = normalizeCount((await safeGet(
      db,
      \`SELECT COUNT(*) AS n FROM funding_opportunities
       WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
         AND link_status = 'broken'
         AND COALESCE(status, 'active') = 'active'
         AND (COALESCE(is_hidden, FALSE) = TRUE OR COALESCE(is_active, TRUE) = FALSE)\`,
    ))?.n)
    const repairPendingBrokenDirect = normalizeCount((await safeGet(
      db,
      \`SELECT COUNT(*) AS n FROM funding_opportunities
       WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
         AND link_status = 'broken' AND status = 'paused'\`,
    ))?.n)
    const retiredBrokenDirect = normalizeCount((await safeGet(
      db,
      \`SELECT COUNT(*) AS n FROM funding_opportunities
       WHERE COALESCE(opportunity_kind,'direct') IN \${directKinds}
         AND ((link_status = 'skipped'
               AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%')
              OR status = 'expired')\`,
    ))?.n)`,
    'Mission broken-link lifecycle metrics',
  )
  replaceOnce(
    'backend/services/missionHealthService.js',
    /      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,/,
    `      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,
        repair_pending_broken_direct_opportunities: repairPendingBrokenDirect,
        retired_broken_direct_opportunities: retiredBrokenDirect,`,
    'Mission lifecycle count response',
  )

  console.log('[source-materialization] link backlog lifecycle repair applied')
}
