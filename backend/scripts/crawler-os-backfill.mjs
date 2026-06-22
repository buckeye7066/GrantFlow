// Run the Crawler OS over every active profile and persist results, so the
// OS-first discovery routes serve OS matches for all profiles (prerequisite for
// removing the legacy route fallback). Idempotent.
// In-container: railway ssh "node backend/scripts/crawler-os-backfill.mjs [--limit=N] [--profile=ID]"
import { getDb } from '../db/index.js';
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const oneArg = process.argv.find((a) => a.startsWith('--profile='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
const onlyId = oneArg ? oneArg.split('=')[1] : null;

async function main() {
  const db = getDb();
  let ids;
  if (onlyId) {
    ids = [onlyId];
  } else {
    const rows = await db
      .prepare(`SELECT id FROM profiles WHERE status = 'active' OR status IS NULL ORDER BY updated_at DESC`)
      .all();
    ids = rows.map((r) => r.id);
    if (limit) ids = ids.slice(0, limit);
  }
  console.log(`[backfill] ${ids.length} profile(s)`);
  let ok = 0;
  let failed = 0;
  let totalMatches = 0;
  let totalPruned = 0;
  for (const id of ids) {
    try {
      const { run, persisted } = await runProfileDiscoveryLive({ db, profileId: id });
      ok += 1;
      totalMatches += persisted.matches;
      totalPruned += persisted.pipelinePruned || 0;
      console.log(`[backfill] ok ${id}: stored=${run.stored} matches=${persisted.matches} recs=${run.recommendations.length} pruned=${persisted.pipelinePruned}`);
    } catch (err) {
      failed += 1;
      console.error(`[backfill] FAIL ${id}: ${err?.message || err}`);
    }
  }
  console.log(`[backfill] done — ok=${ok} failed=${failed} matches=${totalMatches} pipeline_pruned=${totalPruned}`);
  process.exit(failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((e) => { console.error('[backfill] ERROR', e); process.exit(1); });
