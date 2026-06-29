// scripts/amy-cleanup.mjs
//
// Sam-facing cleanup for Amy's synthetic crawler-training profiles. Safe by
// default: only deletes rows created_by 'agent:amy' whose amy_metadata marks
// synthetic + allow_sam_cleanup, never a designated/system profile.
//
// Usage:
//   node scripts/amy-cleanup.mjs --dry-run            # show what WOULD be deleted (default safe preview)
//   node scripts/amy-cleanup.mjs --apply              # delete expired synthetic profiles
//   node scripts/amy-cleanup.mjs --apply --all        # delete ALL Amy synthetic profiles (ignore expiry)
//   node scripts/amy-cleanup.mjs --apply --run=<runId> # delete one run's profiles

import { getDb } from '../backend/db/index.js'
import { cleanupAmyProfiles } from '../backend/services/amy/amyProfileStore.js'

function getFlag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

async function main() {
  const apply = Boolean(getFlag('apply'))
  const all = Boolean(getFlag('all'))
  const runId = typeof getFlag('run') === 'string' ? getFlag('run') : null
  const dryRun = !apply // default is a safe preview

  const db = getDb()
  const result = await cleanupAmyProfiles(db, {
    runId,
    expiredOnly: !all,
    force: all,
    dryRun,
  })

  console.log(`[amy-cleanup] mode=${dryRun ? 'DRY-RUN (preview)' : 'APPLY'} scope=${runId ? `run:${runId}` : all ? 'all' : 'expired'}`)
  console.log(`[amy-cleanup] scanned=${result.scanned} ${dryRun ? 'would_delete' : 'deleted'}=${result.deleted} skipped=${result.skipped}`)
  if (result.ids.length > 0) console.log(`[amy-cleanup] ids: ${result.ids.slice(0, 50).join(', ')}${result.ids.length > 50 ? ' …' : ''}`)
  if (dryRun && result.deleted > 0) console.log('[amy-cleanup] re-run with --apply to delete.')
}

main().catch((e) => { console.error('[amy-cleanup] ERROR', e); process.exit(1) })
