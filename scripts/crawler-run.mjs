#!/usr/bin/env node
/**
 * crawler:run
 *
 * Crawler OS profile discovery runner.
 *
 * Usage:
 *   npm run crawler:run -- <profileId> [--floor=N]
 *   CRAWLER_PROFILE_ID=<profileId> npm run crawler:run
 */

import { getDb } from '../backend/db/index.js'
import { runProfileDiscoveryLive } from '../backend/services/crawlerOsService.js'

const profileId = process.env.CRAWLER_PROFILE_ID || process.argv[2]
const floorArg = process.argv.find((a) => String(a).startsWith('--floor='))
const envFloor = process.env.CRAWLER_MIN_FLOOR || process.env.CRAWLER_FLOOR
const floor = floorArg ? Number(floorArg.split('=')[1]) : envFloor ? Number(envFloor) : undefined

if (!profileId || String(profileId).startsWith('--')) {
  console.error('[crawler:run] usage: npm run crawler:run -- <profileId> [--floor=N]')
  console.error('[crawler:run] National Crawler V2 is retired; Crawler OS requires an explicit profile.')
  process.exit(2)
}

async function main() {
  const db = getDb()
  const profile = await db
    .prepare('SELECT id, display_name, primary_type FROM profiles WHERE id = ?')
    .get(String(profileId))
  if (!profile) {
    console.error(`[crawler:run] profile not found: ${profileId}`)
    process.exit(1)
  }

  const started = Date.now()
  console.log(`[crawler:run] profile=${profile.display_name || profile.id} type=${profile.primary_type || 'untyped'}`)
  const result = await runProfileDiscoveryLive({
    db,
    profileId: String(profileId),
    ...(Number.isFinite(floor) ? { floor } : {}),
  })
  const run = result?.run ?? {}
  const persisted = result?.persisted ?? {}
  console.log('[crawler:run] OK', {
    engine: 'crawler-os',
    stored: run.stored ?? 0,
    rejected: run.rejected ?? 0,
    recommendations: Array.isArray(run.recommendations) ? run.recommendations.length : 0,
    zero_result: run.zero_result?.reason ?? null,
    persisted_opportunities: persisted.opportunities ?? 0,
    persisted_matches: persisted.matches ?? 0,
    duration_ms: Date.now() - started,
  })
}

main().catch((err) => {
  console.error('[crawler:run] FAILED', err?.message || err)
  process.exit(1)
})
