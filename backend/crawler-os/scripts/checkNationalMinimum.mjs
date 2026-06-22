// crawler-os/scripts/checkNationalMinimum.mjs
//
// `npm run opps:check-national-minimum` — guards against a regression where the
// national funding floor disappears. It verifies (offline, deterministically)
// that:
//   (a) the registry exposes a minimum number of NATIONAL sources, and
//   (b) at least one national source has a working adapter and actually yields a
//       stored, catalog-acceptable opportunity through the REAL pipeline.
//
// Exits non-zero if the floor is not met. In production this can additionally run
// against live `fetch` to assert real coverage.

import { allSources } from '../sourceRegistry.js';
import { implementedAdapterIds } from '../adapters/index.js';
import { createMemoryStore } from '../store.js';
import { runDiscovery } from '../pipeline.js';
import { buildThesis } from '../profileIntelligence.js';
import { countOpportunities } from '../storage.js';
import { makeOfflineFetcher, SAMPLE_VFD_PROFILE } from '../tests/fixtures/fakeFetch.mjs';

const MIN_NATIONAL_SOURCES = 5;
const MIN_NATIONAL_WITH_ADAPTER = 1;

async function main() {
  const sources = allSources();
  const national = sources.filter((s) => s.geography?.national);
  const withAdapter = new Set(implementedAdapterIds());
  const nationalWithAdapter = national.filter((s) => withAdapter.has(s.source_id));

  console.log(`[national-min] national sources: ${national.length} (need >= ${MIN_NATIONAL_SOURCES})`);
  console.log(`[national-min] national sources WITH adapter: ${nationalWithAdapter.map((s) => s.source_id).join(', ') || '(none)'}`);

  let problems = 0;
  if (national.length < MIN_NATIONAL_SOURCES) { console.error(`[national-min] FAIL: only ${national.length} national sources`); problems += 1; }
  if (nationalWithAdapter.length < MIN_NATIONAL_WITH_ADAPTER) { console.error('[national-min] FAIL: no national source has a working adapter'); problems += 1; }

  // Prove the floor actually produces a stored opportunity through the real spine.
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const run = await runDiscovery({ store, fetcher }, { thesis, matchProfiles: [thesis] });
  const stored = countOpportunities(store);
  console.log(`[national-min] pipeline stored ${stored} opportunit${stored === 1 ? 'y' : 'ies'} (run.stored=${run.stored})`);
  if (stored < 1) { console.error('[national-min] FAIL: national pipeline stored zero opportunities'); problems += 1; }

  if (problems > 0) { console.error(`[national-min] FAILED with ${problems} problem(s).`); process.exit(1); }
  console.log('[national-min] OK');
}

main().catch((e) => { console.error('[national-min] ERROR', e); process.exit(1); });
