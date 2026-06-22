// scripts/crawler-os-crawl.mjs
//
// Run a REAL Crawler OS discovery for one live profile against the configured DB
// and persist the results. This is the operator/CLI entry that exercises the
// exact seam Robert and the discovery routes use.
//
//   node scripts/crawler-os-crawl.mjs <profileId> [--floor=N]
//
// Live network: fetching goes through the OS fetcher (safeUrl + DNS-rebind guard
// + rate limit + evidence hash). Sources without an API key skip honestly.

import { getDb } from '../backend/db/index.js';
import { runProfileDiscoveryLive } from '../backend/services/crawlerOsService.js';
import { storage } from '../backend/crawler-os/index.js';

const profileId = process.argv[2];
const floorArg = process.argv.find((a) => a.startsWith('--floor='));
const floor = floorArg ? Number(floorArg.split('=')[1]) : undefined;

if (!profileId) {
  console.error('usage: node scripts/crawler-os-crawl.mjs <profileId> [--floor=N]');
  process.exit(2);
}

async function main() {
  const db = getDb();
  const profile = await db.prepare('SELECT id, display_name, primary_type FROM profiles WHERE id = ?').get(profileId);
  if (!profile) { console.error(`[crawl] profile not found: ${profileId}`); process.exit(1); }
  console.log(`[crawl] profile: ${profile.display_name} (${profile.primary_type ?? 'untyped'}) ${profileId}`);

  const t0 = Date.now();
  const { run, persisted, thesis } = await runProfileDiscoveryLive({ db, profileId, floor });
  const ms = Date.now() - t0;

  console.log(`[crawl] thesis: types=[${thesis.applicant_types.join(',')}] needs=[${thesis.needs.join(',')}] ` +
    `loc=${thesis.location.state ?? '?'}/${thesis.location.zip ?? '?'} floor=${thesis.min_match_score}`);
  console.log(`[crawl] sources:`);
  for (const s of run.sources) {
    console.log(`   ${s.source_id.padEnd(14)} ${s.outcome}${s.reason ? ` (${s.reason})` : ''} ` +
      `fetched=${s.fetched} parsed=${s.parsed} stored=${s.stored} rejected=${s.rejected} deduped=${s.deduped}`);
  }
  console.log(`[crawl] run: stored=${run.stored} rejected=${run.rejected} recommendations=${run.recommendations.length} ` +
    `zero_result=${run.zero_result?.reason ?? 'n/a'}`);
  console.log(`[crawl] persisted to live DB: opportunities=${persisted.opportunities} matches=${persisted.matches} sources=${persisted.sources}`);

  // Show top matches for this profile from the OS run.
  const top = run.recommendations.slice(0, 8);
  if (top.length) {
    console.log(`[crawl] top recommendations:`);
    for (const r of top) console.log(`   ${String(r.match_score).padStart(3)}  ${r.decision.padEnd(7)} ${r.title} — ${r.sponsor ?? ''}`);
  }
  console.log(`[crawl] done in ${ms}ms`);
  void storage;
}

main().catch((e) => { console.error('[crawl] ERROR', e); process.exit(1); });
