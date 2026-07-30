import fs from 'node:fs'

const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, value) => fs.writeFileSync(file, value)

function countMatches(value, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return value.match(new RegExp(pattern.source, flags))?.length || 0
}

function preflightOperation(operation) {
  const before = read(operation.file)
  if (operation.type === 'replace') {
    const matches = countMatches(before, operation.pattern)
    if (matches !== 1) {
      throw new Error(
        `[source-materialization] prerequisite missing before mutation: ${operation.label} ` +
        `(${operation.file}; expected one match, found ${matches})`,
      )
    }
    return
  }

  const first = before.indexOf(operation.marker)
  if (first < 0 || before.indexOf(operation.marker, first + operation.marker.length) >= 0) {
    throw new Error(
      `[source-materialization] prerequisite missing before mutation: ${operation.label} ` +
      `(${operation.file}; marker missing or ambiguous)`,
    )
  }
}

function applyOperation(operation) {
  const before = read(operation.file)
  if (operation.type === 'replace') {
    write(operation.file, before.replace(operation.pattern, operation.replacement))
    return
  }

  const first = before.indexOf(operation.marker)
  write(
    operation.file,
    before.slice(0, first + operation.marker.length) + operation.addition + before.slice(first + operation.marker.length),
  )
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

  // Every prerequisite is validated before the first write. If an independent
  // invocation lacks apply-code.mjs's mission-health block (or any other base
  // shape), the materializer fails cleanly instead of leaving a half-applied tree.
  const operations = [
    {
      type: 'replace',
      file: 'backend/services/crawlers/nationalZipCrawler.js',
      pattern: /  const url = pickFirstUrl\([\s\S]*?\n  \)\n  if \(!url\) return null/,
      replacement: `  const contactUrl = pickFirstUrl(
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
    const osmId = /^\d+$/.test(String(element?.id || '')) ? String(element.id) : null
    const url = osmType && osmId ? \`https://www.openstreetmap.org/\${osmType}/\${osmId}\` : null
    if (!url) return null`,
      label: 'Overpass stable-resource URL',
    },
    {
      type: 'replace',
      file: 'backend/services/crawlers/nationalZipCrawler.js',
      pattern: /    opportunity_type: 'benefit',\n    type: 'PROGRAM',/,
      replacement: `    opportunity_kind: 'directory',
      result_kind: 'directory',
      opportunity_type: 'directory',
      type: 'DIRECTORY',
      record_origin: 'directory_resource',
      source_trust_tier: 'community_directory',
      contact_info: contactUrl ? { website: contactUrl } : null,`,
      label: 'Overpass resource classification',
    },
    {
      type: 'replace',
      file: 'backend/services/linkVerificationService.js',
      pattern: /        headers: \{\n          'User-Agent': 'GrantFlow-LinkChecker\/1\.0 \(contact: support@grantflow\.app\)',\n        \},/,
      replacement: `        headers: {
            // browser-compatible liveness probe: transparent product token plus
            // normal document headers avoids false 403/404 results from servers
            // that reject bare programmatic HEAD requests.
            'User-Agent': 'Mozilla/5.0 (compatible; GrantFlowLinkVerifier/2.0; +https://app.axiombiolabs.org)',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },`,
      label: 'Verifier request headers',
    },
    {
      type: 'replace',
      file: 'backend/services/linkVerificationService.js',
      pattern: /  if \(outcome\.code === 405 \|\| outcome\.code === 403 \|\| outcome\.code === 501\) \{/,
      replacement: `  if (outcome.code === null || outcome.code < 200 || outcome.code >= 400) {`,
      label: 'HEAD-to-GET fallback',
    },
    {
      type: 'replace',
      file: 'backend/services/linkVerificationService.js',
      pattern: /        WHERE \(application_url IS NOT NULL OR source_url IS NOT NULL\)\n          AND \(last_verified_at IS NULL OR last_verified_at < \?\)\n        ORDER BY \(last_verified_at IS NULL\) DESC, last_verified_at ASC/,
      replacement: `        WHERE (application_url IS NOT NULL OR source_url IS NOT NULL)
            AND NOT (
              link_status = 'skipped'
              AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'
            )
            AND (link_status = 'broken' OR last_verified_at IS NULL OR last_verified_at < ?)
          ORDER BY CASE WHEN link_status = 'broken' THEN 0 ELSE 1 END,
                   (last_verified_at IS NULL) DESC, last_verified_at ASC`,
      label: 'Broken-link priority selection',
    },
    {
      type: 'replace',
      file: 'backend/services/linkVerificationService.js',
      pattern: /  const hide = db\.prepare\(`\n    UPDATE funding_opportunities\n    SET is_hidden = 1\n    WHERE id = \?\n  `\)/,
      replacement: `  const hide = db.prepare(\`
      UPDATE funding_opportunities
      SET is_hidden = ?
      WHERE id = ?
    \`)`,
      label: 'Postgres-safe hide SQL',
    },
    {
      type: 'replace',
      file: 'backend/services/linkVerificationService.js',
      pattern: /            await hide\.run\(row\.id\)/,
      replacement: `            await hide.run(isPostgres ? true : 1, row.id)`,
      label: 'Postgres-safe hide call',
    },
    {
      type: 'insert_after',
      file: 'backend/server.js',
      marker: "app.use('/api/admin/queue', adminQueueOpsRouter)",
      addition: "\napp.use('/api/admin/link-repair', lazyRouter('./routes/linkBacklogRepair.js'))",
      label: 'Link repair route mount',
    },
    {
      type: 'replace',
      file: 'backend/server.js',
      pattern: /        console\.log\('\[link-verify\] completed:', stats\)/,
      replacement: `        console.log('[link-verify] completed:', stats)
          const { repairBrokenDirectBatch } = await import('./services/linkBacklogRepairService.js')
          const lifecycle = await repairBrokenDirectBatch(dbInstance, {
            limit: Math.min(100, limit),
            concurrency: 8,
            timeoutMs: 10_000,
            verifiedBy: \`recurring-link-repair:pid=\${process.pid}\`,
          })
          console.log('[link-repair] recurring lifecycle pass:', lifecycle)`,
      label: 'Recurring link lifecycle pass',
    },
    {
      type: 'replace',
      file: 'backend/services/missionHealthService.js',
      pattern: /  const quarantinedBrokenDirect = normalizeCount\(\(await safeGet\(\n    db,\n    `SELECT COUNT\(\*\) AS n FROM funding_opportunities\n     WHERE COALESCE\(opportunity_kind,'direct'\) IN \$\{directKinds\}\n       AND link_status = 'broken'\n       AND \(COALESCE\(is_hidden, FALSE\) = TRUE OR COALESCE\(is_active, TRUE\) = FALSE\)`,\n  \)\)\?\.n\)/,
      replacement: `  const quarantinedBrokenDirect = normalizeCount((await safeGet(
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
         AND link_status = 'skipped'
         AND COALESCE(verification_error, '') LIKE 'retired_after_definitive_recheck:%'\`,
    ))?.n)`,
      label: 'Mission broken-link lifecycle metrics',
    },
    {
      type: 'replace',
      file: 'backend/services/missionHealthService.js',
      pattern: /      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,/,
      replacement: `      quarantined_broken_direct_opportunities: quarantinedBrokenDirect,
        repair_pending_broken_direct_opportunities: repairPendingBrokenDirect,
        retired_broken_direct_opportunities: retiredBrokenDirect,`,
      label: 'Mission lifecycle count response',
    },
  ]

  for (const operation of operations) preflightOperation(operation)

  // Snapshot every touched file and roll all of them back if an unexpected write
  // failure occurs. The lifecycle patch is therefore all-or-nothing.
  const originals = new Map([...new Set(operations.map((operation) => operation.file))].map((file) => [file, read(file)]))
  try {
    for (const operation of operations) applyOperation(operation)
  } catch (error) {
    for (const [file, original] of originals) write(file, original)
    throw error
  }

  console.log('[source-materialization] link backlog lifecycle repair applied')
}
