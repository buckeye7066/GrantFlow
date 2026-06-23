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

// method+path -> reason. Pre-existing only. Anything NOT here that breaks fails the gate.
const KNOWN_ALLOWLIST = new Map([
  // Tables that exist in production Postgres (schema.sql) but are not created
  // in the in-memory SMOKE sqlite migration set, so these GETs 500 with
  // "no such table" here only. Not a production defect.
  ['GET /api/applications/:id', 'smoke: no such table: applications (exists in prod)'],
  ['GET /api/applications/:id/sections', 'smoke: no such table: applications'],
  ['GET /api/applications/:id/checklist', 'smoke: no such table: applications'],
  ['GET /api/applications/:id/artifacts/:artifactId/download', 'smoke: no such table: applications'],
  ['GET /api/application-workflow/:applicationId', 'smoke: no such table: grant_applications'],
  ['GET /api/grant-applications', 'smoke: no such table: grant_applications'],
  ['GET /api/grant-applications/:id', 'smoke: no such table: grant_applications'],
  ['GET /api/opportunities/meta/ingestion', 'smoke: no such table: ingestion_runs'],
  ['GET /api/source-directory', 'smoke: no such table: source_directory'],
  ['GET /api/source-directory/:id', 'smoke: no such table: source_directory'],
  // 500-on-missing-placeholder-id (should arguably be 404) — PRE-EXISTING graceful-degradation gaps.
  ['GET /api/foundations/profile-region/:profileId', 'pre-existing: 500 on missing profile id (should be 404)'],
  ['GET /api/onboarding/sessions/:id', 'pre-existing: 500 on missing session id (should be 404)'],
  ['GET /api/billing/me/:profileId', 'pre-existing: FK constraint on missing profile id'],
  ['GET /api/profiles/:id/portals/packet/:documentId/download', 'pre-existing: 500 on missing packet'],
  ['GET /api/admin/dead-letter-queue', 'pre-existing: param-binding bug (Too many parameter values)'],
  // Enumeration artifacts: declared path 404s at the root because the real
  // surface is a sub-path or a non-GET verb.
  ['GET /api/admin/knowledge/opportunities', 'enumeration artifact: 404 at this exact path'],
  ['GET /api/vnext/applications', 'enumeration artifact: root GET not defined (sub-routes only)'],
])

describe('endpoint sweep — every GET endpoint is mounted and not 5xx (allowlist for pre-existing smoke gaps)', () => {
  let app
  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
  }, 60_000)

  it('finds no NEW not_mounted or broken GET endpoint', async () => {
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
      const broken = status >= 500 || status === -1
      const notMounted = status === 404 && !parameterized
      if (broken || notMounted) {
        const key = `${ep.method} ${ep.fullPath}`
        if (!KNOWN_ALLOWLIST.has(key)) {
          offenders.push(`${key} -> ${status} (${ep.file})`)
        }
      }
    }

    expect(
      offenders,
      `New unmounted/broken GET endpoints (fix the handler or add a documented allowlist entry):\n${offenders.join('\n')}`,
    ).toEqual([])
  }, 180_000)
})
