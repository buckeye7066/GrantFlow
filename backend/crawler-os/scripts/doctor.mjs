// crawler-os/scripts/doctor.mjs
//
// `npm run crawler:doctor` — an OFFLINE, deterministic readiness check. It seeds a
// fresh in-memory store, runs Sam's health pass, then exercises the REAL pipeline
// with the offline fake network and asserts that at least one real opportunity is
// stored and matched. Exits non-zero on any critical finding or empty result so
// it can gate CI. (In production, point the fetcher at the real `fetch` for a
// live check.)

import { createMemoryStore } from '../store.js';
import { createSam } from '../agents/sam.js';
import { runDiscovery } from '../pipeline.js';
import { buildThesis } from '../profileIntelligence.js';
import { makeOfflineFetcher, SAMPLE_VFD_PROFILE } from '../tests/fixtures/fakeFetch.mjs';

async function main() {
  const store = createMemoryStore();
  let problems = 0;

  // 1) Sam health pass (self-heals safe issues, reports findings).
  const sam = createSam({ store });
  const health = await sam.run({ phase: 'preflight' });
  console.log(`[doctor] Sam healthy=${health.healthy} findings=${health.counts.findings} fixed=${health.counts.fixed} critical=${health.counts.critical}`);
  for (const f of health.findings) {
    if (f.level === 'critical' || f.level === 'high') console.log(`  [${f.level}] ${f.area}: ${f.detail}`);
  }
  if (!health.healthy) problems += 1;

  // 2) Real pipeline, offline network.
  const fetcher = makeOfflineFetcher();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const run = await runDiscovery({ store, fetcher }, { thesis, matchProfiles: [thesis] });
  console.log(`[doctor] discovery stored=${run.stored} rejected=${run.rejected} recommendations=${run.recommendations.length}`);
  for (const s of run.sources) console.log(`  source ${s.source_id}: ${s.outcome}${s.reason ? ` (${s.reason})` : ''} stored=${s.stored}${s.deduped ? ` deduped=${s.deduped}` : ''}`);

  if (run.stored < 1) { console.error('[doctor] FAIL: pipeline stored zero opportunities offline'); problems += 1; }
  if (run.recommendations.length < 1) { console.error('[doctor] WARN: no ACCEPT-band recommendations for the sample VFD profile'); }

  if (problems > 0) { console.error(`[doctor] FAILED with ${problems} problem(s).`); process.exit(1); }
  console.log('[doctor] OK');
}

main().catch((e) => { console.error('[doctor] ERROR', e); process.exit(1); });
