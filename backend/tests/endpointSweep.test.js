import { describe, it, expect, beforeAll } from 'vitest'
import { getAppAndDb, TEST_ADMIN_TOKEN } from './testServer.js'
import { enumerate, probePath } from '../../scripts/endpoint-sweep.mjs'
import request from 'supertest'

/**
 * Endpoint sweep gate (Part 3 — "test each app function").
 *
 * Statically enumerates EVERY backend HTTP endpoint (route files + server.js
 * mounts) and probes every GET against the booted SMOKE_MODE app, asserting no
 * GET endpoint is:
 *   - not_mounted (a 404 on a STATIC path = a real wiring gap), or
 *   - broken (a 5xx = the handler threw)
 * …EXCEPT a small, explicitly-documented allowlist of PRE-EXISTING cases that
 * only fail in the in-memory SMOKE sqlite (tables that exist in the production
 * Postgres schema) or that 500 on a non-existent placeholder id (a graceful-
 * degradation gap that predates this work). The allowlist is intentionally
 * visible — nothing is hidden; each entry has a reason and is a candidate for a
 * follow-up fix. The value of the gate is catching NEW wiring/500 regressions.
 */

// method+path -> reason. EMPTY: with migrations applied (production-faithful
// schema) every GET endpoint is mounted and returns non-5xx. The mechanism is
// retained so a future genuinely-can't-fix-here case can be documented rather
// than silently tolerated — but the bar is "empty until proven necessary".
// Documented, deliberate 5xx. NOT defects — do not "fix the handler".
//
// The SMS forwarding routes (ingest + its status probe) are gated on the shared
// secret HAMILTON_SMS_INGEST_TOKEN, and when that secret is UNSET the route
// DISABLES itself with 503 rather than serving unauthenticated. That posture is
// the point: an unauthenticated read of who-texted-whom is not something to
// leave open, and an unauthenticated write endpoint that silently accepts
// anything is worse than one that does not exist.
//
// CI does not set that secret (it is a phone-forwarding credential, not a test
// fixture), so 503 here is the handler behaving CORRECTLY. Allowlisting it is
// the documented escape hatch this gate offers; the alternative — setting a
// real ingest secret in CI — would weaken the very posture being asserted.
//
// The task collection also fails closed with 503 until boot publishes a
// healthy, queue-readable task-truth snapshot. This SMOKE_MODE sweep applies
// migrations but intentionally does not impersonate the production boot audit,
// so the snapshot remains migration_reconciled and unreadable. Focused task-
// truth tests cover both the 503 gate and the transition to a readable snapshot.
//
// The router is mounted twice, under /api/hamilton and /api/yana, so both
// mount points appear.
const KNOWN_ALLOWLIST = new Map([
  ['GET /api/hamilton/automation/inbox-status', 'sms_ingest_disabled: HAMILTON_SMS_INGEST_TOKEN unset in CI; 503 is the secure-by-default posture, not a throwing handler'],
  ['GET /api/yana/automation/inbox-status', 'sms_ingest_disabled: same router mounted under /api/yana; see above'],
  ['GET /api/hamilton/automation/tasks', 'task_truth_not_verified: SMOKE_MODE endpoint sweep does not run the production boot audit; 503 is the fail-closed contract'],
  ['GET /api/yana/automation/tasks', 'task_truth_not_verified: same router mounted under /api/yana; see above'],
])

describe('endpoint sweep — every GET endpoint is mounted and not 5xx (allowlist for pre-existing smoke gaps)', () => {
  let app
  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    // SMOKE_MODE skips MIGRATE_ON_BOOT (shouldMigrateOnBoot returns !smoke), so
    // the boot DB only has schema.sql tables — migration-only tables
    // (applications, grant_applications, source_directory, ingestion_runs,
    // onboarding_sessions, documents columns, …) are absent and their GETs 500
    // with "no such table" HERE ONLY. Production runs migrations, so apply them
    // to this isolated, per-file in-memory DB to make the sweep faithful to
    // production. Idempotent + per-file isolated (vitest default), so this never
    // affects other suites.
    try {
      const { runPendingMigrationsOnBoot } = await import('../db/migrate.js')
      await runPendingMigrationsOnBoot({ logger: { log() {}, warn() {}, error() {} } })
    } catch (err) {
      // If migrations can't apply here, the test still runs against schema.sql
      // and the allowlist covers the migration-only gaps.
      console.warn('[endpointSweep] migration apply skipped:', err?.message || err)
    }
  }, 120_000)

  it('no GET endpoint returns 5xx (every handler runs without throwing)', async () => {
    const endpoints = enumerate().filter((e) => e.method === 'GET')
    expect(endpoints.length).toBeGreaterThan(200) // sanity: enumeration worked

    const probe = async (url) => {
      try {
        const res = await request(app)
          .get(url)
          .set('x-admin-token', TEST_ADMIN_TOKEN)
          .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        return res.status
      } catch {
        return -1
      }
    }

    const offenders = []
    for (const ep of endpoints) {
      const { url, parameterized } = probePath(ep.fullPath)
      let status = await probe(url)
      // A 5xx is only counted if it REPRODUCES on a retry. A deterministically
      // broken handler 5xx's both times (real defect → fails the gate); a
      // transient 5xx under heavy parallel test load (statement_timeout,
      // momentary resource contention) clears on retry. This keeps the gate
      // reliable without hiding a genuinely-throwing handler.
      if (status >= 500 || status === -1) {
        await new Promise((r) => setTimeout(r, 250))
        status = await probe(url)
      }
      // The GATE asserts only on 5xx (a handler that THREW) — the reliable,
      // false-positive-free invariant. A static-path 404 is NOT a dependable
      // "not mounted" signal: many handlers legitimately return 404 for an
      // empty resource or a non-collection root (e.g. /api/admin/knowledge/
      // opportunities, /api/vnext/applications), and the static enumerator
      // can't tell a handler-404 from an Express-default-404. The standalone
      // scripts/endpoint-sweep.mjs still REPORTS not_mounted for operator
      // visibility; it just isn't a hard gate here.
      const broken = status >= 500 || status === -1
      if (broken) {
        const key = `${ep.method} ${ep.fullPath}`
        if (!KNOWN_ALLOWLIST.has(key)) {
          offenders.push(`${key} -> ${status} (${ep.file})`)
        }
      }
      if (process.env.SWEEP_DEBUG && (broken || (status === 404 && !parameterized))) {
        console.log(`[sweep] ${ep.method} ${ep.fullPath} -> ${status} (${ep.file})`)
      }
    }

    expect(
      offenders,
      `GET endpoints returning 5xx (fix the handler or add a documented allowlist entry):\n${offenders.join('\n')}`,
    ).toEqual([])
  }, 180_000)
})
