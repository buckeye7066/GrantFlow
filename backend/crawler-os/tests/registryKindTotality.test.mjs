// Registry kind/classification totality — a source's `directory` flag, its
// `default_kinds`, and what its adapter actually emits must agree, for EVERY
// source (not just the ones a reviewer remembered to spot-check).
//
// Why this exists: real benefit programs (SSDI, Black Lung, MyCAA) were
// registered `directory:true` — not because they are directories, but because
// only DIRECTORY-kind rows survived fetch failures (pipeline.js). That
// mislabeled honest programs as locators (apply_url stripped, ranked as
// directories, never countable as direct programs). Survival is now
// kind-agnostic for registry-built candidates, so the classification can be
// honest — and this test keeps it honest mechanically.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allSources } from '../sourceRegistry.js';
import { getAdapter } from '../adapters/index.js';
import { OPPORTUNITY_KIND, REALITY_STATUS } from '../contract.js';
import { createMemoryStore } from '../store.js';
import { runDiscovery } from '../pipeline.js';
import { buildThesis } from '../profileIntelligence.js';
import { storage } from '../index.js';
import { makeOfflineFetcher } from './fixtures/fakeFetch.mjs';

test('totality: every directory source defaults to DIRECTORY kind; every non-directory source served by the directory-family adapter declares an honest non-DIRECTORY kind', () => {
  for (const source of allSources()) {
    const kinds = source.default_kinds || [];
    if (source.directory) {
      assert.ok(
        kinds.includes(OPPORTUNITY_KIND.DIRECTORY),
        `${source.source_id}: directory:true but default_kinds=${JSON.stringify(kinds)} — a locator's rows are DIRECTORY kind`,
      );
      continue;
    }
    const adapter = getAdapter(source.source_id);
    if (adapter?.family === 'directory') {
      assert.ok(
        kinds.length > 0 && kinds[0] !== OPPORTUNITY_KIND.DIRECTORY,
        `${source.source_id}: directory:false with a registry-candidate adapter but default_kinds=${JSON.stringify(kinds)} — it would still emit DIRECTORY rows; declare its honest kind (BENEFIT/SCHOLARSHIP/PROGRAM/…) or mark it directory:true`,
      );
    }
  }
});

test('a real benefit program survives a fetch failure with its HONEST kind as link_unverified (never relabeled directory, never claimed verified)', async () => {
  // ssa.gov intermittently 403s automated fetchers — the documented case that
  // used to force ssa_disability to be registered as a fake "directory".
  const store = createMemoryStore();
  const thesis = buildThesis({
    id: 'profile_kind_totality_1',
    primary_type: 'individual',
    name: 'registry kind totality fixture',
    needs: ['disability'],
    state: 'OH',
  });
  const run = await runDiscovery(
    {
      store,
      fetcher: makeOfflineFetcher({ fail: new Set(['ssa.gov']) }),
      env: {},
      clock: () => 1_786_000_000_000,
    },
    { thesis, matchProfiles: [thesis], runId: 'run_kind_totality' },
  );
  assert.ok(run.stored >= 1, 'run stores rows despite the ssa.gov failure');
  const ssaRows = storage.listCatalog(store).filter((row) => row.source_id === 'ssa_disability');
  assert.equal(ssaRows.length, 1, `expected exactly one ssa_disability row, got ${ssaRows.length}`);
  const [ssdi] = ssaRows;
  assert.equal(ssdi.kind, OPPORTUNITY_KIND.BENEFIT, 'SSDI/SSI keeps its honest BENEFIT kind on fetch failure');
  assert.equal(ssdi.reality_status, REALITY_STATUS.LINK_UNVERIFIED, 'no fetched page → honestly link_unverified, never verified');
  assert.equal(ssdi.apply_url, 'https://www.ssa.gov/disability', 'the official application entry point is preserved, not stripped');
});
