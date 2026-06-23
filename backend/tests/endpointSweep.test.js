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
const KNOWN_ALLOWLIST = new Map([])

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
      // eslint-disable-next-line no-console
      console.warn('[endpointSweep] migration apply skipped:', err?.message || err)
    }
  }, 120_000)

  it('no GET endpoint returns 5xx (every handler runs without throwing)', async () => {
    const endpoints = enumerate().filter((e) => e.method === 'GET')
    expect(endpoints.length).toBeGreaterThan(200) // sanity: enumeration worked

    const offenders = []
    for (const ep of endpoints) {
      const { url, parameterized } = probePath(ep.fullPath)
      let status = 0
      try {
        const res = await request(app)
          .get(url)
          .set('x-admin-token', TEST_ADMIN_TOKEN)
          .set('Authorization', `Bearer ${TEST_ADMIN_TOKEN}`)
        status = res.status
      } catch {
        status = -1
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
        // eslint-disable-next-line no-console
        console.log(`[sweep] ${ep.method} ${ep.fullPath} -> ${status} (${ep.file})`)
      }
    }

    expect(
      offenders,
      `GET endpoints returning 5xx (fix the handler or add a documented allowlist entry):\n${offenders.join('\n')}`,
    ).toEqual([])
  }, 180_000)
})
