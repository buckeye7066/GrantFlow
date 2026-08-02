/**
 * amyGapLoopEndToEnd.test.js — the loop, through `runAmyTraining`, offline.
 *
 * Two claims that can ONLY be checked at the agent level:
 *
 *  1. THE PERSISTED REPORT CARRIES THE DELETION PROOF. Cleanup used to run
 *     AFTER `saveAmyReport`, so `combined.cleanup` was assigned to an object
 *     already written to `system_kv amy_last_report`. Verified read-only in
 *     prod 2026-08-02T04:50Z: the stored report for the 03:19Z run has BOTH
 *     `cleanup` and `cleanup_expired` undefined, while 55 rows with
 *     `created_by='agent:amy'` were live out of 92 profiles. A cleanup with no
 *     persisted proof is indistinguishable from no cleanup. These tests read
 *     the STORED report, not the returned object, because only the stored one
 *     reaches the owner.
 *
 *  2. THE COHORT IS NO LONGER THE CATALOG. The run must build adversarial
 *     intersection profiles alongside the catalog floor, and the catalog floor
 *     must survive.
 */

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runAmyTraining } from '../services/amy/amyAgent.js'
import { readLatestAmyReport } from '../services/amy/amyReportStore.js'
import { listAmyProfiles } from '../services/amy/amyProfileStore.js'
import { CATEGORY_IDS } from '../services/amy/syntheticProfileCatalog.js'
import { readProbeCoverage, summarizeCoverage } from '../services/amy/probeCoverageLedger.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT,
      status TEXT DEFAULT 'active', tags TEXT DEFAULT '[]',
      created_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL, section_key TEXT NOT NULL, data TEXT NOT NULL,
      updated_by TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  return db
}

/** Offline discovery: always returns a small, clean-ish result. */
function fakeDiscovery() {
  return async () => ({
    run: {
      run_id: 'r',
      stored: 6,
      sources: [{ source_id: 's1', outcome: 'OK' }],
      recommendations: [
        { title: 'A County Community Foundation Scholarship', decision: 'ACCEPT', match_score: 40, kind: 'PROGRAM', amount_max: 2500 },
        { title: 'B State Housing Program', decision: 'REVIEW', match_score: 20, kind: 'PROGRAM', amount_max: 1200 },
      ],
    },
    persisted: { opportunities: 6 },
    thesis: { applicant_types: ['x'], needs: ['funding'], location: { state: 'TN' } },
  })
}

const RUN = {
  perCategory: 1,
  dryRunDiscovery: false,
  saveReport: true,
  gapLearning: false,
  improve: false,
}

describe('the persisted report proves the synthetic profiles were deleted', () => {
  it('stores cleanup + a PROVEN deletion verdict, and leaves zero rows', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        ...RUN,
        db,
        targetCount: 12,
        categories: CATEGORY_IDS.slice(0, 6),
        runDiscovery: fakeDiscovery(),
        clock: () => new Date('2026-08-03T04:00:00Z'),
      })

      // The STORED report — the one the admin panel and the email read.
      const stored = await readLatestAmyReport(db)
      expect(stored).toBeTruthy()
      expect(stored.cleanup, 'cleanup missing from the PERSISTED report').toBeTruthy()
      expect(stored.deletion_proof, 'deletion_proof missing from the PERSISTED report').toBeTruthy()
      expect(stored.deletion_proof.verdict).toBe('proven')
      expect(stored.deletion_proof.profiles_before).toBe(out.created_profile_ids.length)
      expect(stored.deletion_proof.profiles_after).toBe(0)
      expect(stored.deletion_proof.expired_survivor_count).toBe(0)
      expect(stored.deletion_proof.reported_deleted).toBe(out.created_profile_ids.length)

      // And the DB agrees.
      expect((await listAmyProfiles(db)).length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('reports UNKNOWN — never proven — when profiles are deliberately kept', async () => {
    const db = createDb()
    try {
      await runAmyTraining({
        ...RUN,
        db,
        targetCount: 6,
        categories: CATEGORY_IDS.slice(0, 3),
        keepProfiles: true,
        runDiscovery: fakeDiscovery(),
        clock: () => new Date('2026-08-03T04:00:00Z'),
      })
      const stored = await readLatestAmyReport(db)
      expect(stored.deletion_proof.verdict).toBe('unknown')
      expect((await listAmyProfiles(db)).length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })
})

describe('the cohort is a catalog FLOOR plus adversarial probes', () => {
  it('builds intersection probes alongside the catalog and folds their coverage', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        ...RUN,
        db,
        targetCount: 20,
        categories: CATEGORY_IDS.slice(0, 10),
        runDiscovery: fakeDiscovery(),
        clock: () => new Date('2026-08-03T04:00:00Z'),
      })

      const probes = out.combined.gap_probes
      expect(probes.enabled).toBe(true)
      expect(probes.built).toBeGreaterThan(0)
      expect(probes.split.catalog).toBeGreaterThanOrEqual(10) // the floor held
      expect(probes.split.catalog + probes.split.adversarial).toBe(20)
      expect(out.summary.scenarios).toBe(20)
      // Every probe is a real 4-axis intersection, not a catalog replay.
      for (const cell of probes.cells) {
        expect(cell.entity).toBeTruthy()
        expect(cell.identity).toBeTruthy()
        expect(cell.need).toBeTruthy()
        expect(cell.state).toBeTruthy()
      }

      // The coverage ledger recorded them, and ONLY them.
      const ledger = await readProbeCoverage(db)
      const summary = summarizeCoverage(ledger)
      expect(out.combined.probe_coverage.probes_folded).toBe(probes.built)
      expect(summary.pairs_covered).toBeGreaterThan(0)
      expect(summary.pairs_covered).toBeLessThanOrEqual(probes.built * 6)
      expect(summary.pairs_total).toBeGreaterThan(5000)
    } finally {
      db.close()
    }
  })

  it('AMY_ADVERSARIAL=0 returns to catalog-only and SAYS so', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        ...RUN,
        db,
        adversarial: false,
        targetCount: 12,
        categories: CATEGORY_IDS.slice(0, 6),
        runDiscovery: fakeDiscovery(),
        clock: () => new Date('2026-08-03T04:00:00Z'),
      })
      expect(out.combined.gap_probes.enabled).toBe(false)
      expect(out.combined.gap_probes.built).toBe(0)
      // REGRESSION: sizing the catalog from the RESERVED share instead of the
      // BUILT count made this run 7 profiles instead of 12 — a cohort that
      // silently shrank whenever the probe lane produced nothing.
      expect(out.summary.scenarios).toBe(12)
      expect(out.combined.gap_probes.catalog_built).toBe(12)
    } finally {
      db.close()
    }
  })

  it('attaches a convergence verdict that never claims more than the data', async () => {
    const db = createDb()
    try {
      const out = await runAmyTraining({
        ...RUN,
        db,
        targetCount: 20,
        categories: CATEGORY_IDS.slice(0, 10),
        runDiscovery: fakeDiscovery(),
        clock: () => new Date('2026-08-03T04:00:00Z'),
      })
      // One night of history cannot support a trend claim, and must not make one.
      expect(out.combined.convergence.trend).toBe('insufficient_history')
      expect(out.combined.convergence.goal_reachable).toBe(true)
    } finally {
      db.close()
    }
  })
})
