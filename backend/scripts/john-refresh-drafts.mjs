/**
 * John — refresh existing Outlook draft bodies to the current template.
 *
 * Rewrites the body/subject of every draft John has already created so they
 * reflect the latest messaging (honest origin story + self-serve Anya CTA).
 * Never sends — Microsoft Graph PATCH only.
 *
 * Usage (run where the MICROSOFT_, JOHN_, and DATABASE_URL env vars are set — e.g. prod):
 *   railway run node backend/scripts/john-refresh-drafts.mjs --dry-run
 *   railway run node backend/scripts/john-refresh-drafts.mjs
 *
 * Flags:
 *   --dry-run     compute + show what would change, do not PATCH or persist
 *   --limit=N     scan at most N tracked drafts (default 500)
 */

import { db } from '../db/index.js'
import { refreshDraftBodies } from '../services/john/johnDraftRefreshService.js'
import { getJohnConfig } from '../services/john/johnOutreachSafety.js'

function parseArgs(argv) {
  const out = { dryRun: false, limit: undefined }
  for (const a of argv.slice(2)) {
    if (a === '--dry-run' || a === '--dryRun') out.dryRun = true
    else if (a.startsWith('--limit=')) out.limit = Number(a.split('=')[1])
  }
  return out
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv)
  const cfg = getJohnConfig()

  console.log('[john-refresh-drafts] starting', {
    dryRun,
    limit: limit ?? 500,
    primaryMailbox: cfg.primaryMailbox,
    prospectLink: cfg.prospectLink,
    graphConfigured: !!(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret),
  })

  const result = await refreshDraftBodies(db, { dryRun, limit, logger: console })

  console.log('[john-refresh-drafts] result', {
    ok: result.ok,
    scanned: result.scanned,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed,
    dry_run: result.dry_run,
    error: result.error,
    missing: result.missing,
  })
  for (const r of result.results || []) {
    console.log(`  - ${r.status.padEnd(18)} ${r.org || '(no org)'}  draft=${r.draft_id}${r.reasons ? '  reasons=' + r.reasons.join(',') : ''}${r.error ? '  error=' + r.error : ''}`)
  }

  // Non-zero exit if the provider wasn't configured or any draft hard-failed.
  if (!result.ok || (result.failed || 0) > 0) process.exitCode = 1
}

main()
  .then(() => { setTimeout(() => process.exit(process.exitCode || 0), 100) })
  .catch((err) => {
    console.error('[john-refresh-drafts] fatal', err?.message || err)
    process.exit(1)
  })
