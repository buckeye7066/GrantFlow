#!/usr/bin/env node
/**
 * verify-school-portal-live.mjs
 *
 * End-to-end walk of the school-portal bridge against a running backend.
 *
 * Steps (no admin auth used — we seed the partner + key directly into the
 * SQLite db, then exercise the public partner endpoints over HTTP):
 *
 *   1. Apply migrations + seed a school partner & API key.
 *   2. POST /api/school-portal/students/sync — merge a roster of 2 students.
 *   3. GET  /api/school-portal/me                              — sanity check
 *   4. GET  /api/school-portal/students/:id                    — snapshot
 *   5. GET  /api/school-portal/students/:id/matches            — must return >0
 *   6. POST /api/school-portal/students/:id/revoke             — consent off
 *   7. GET  matches again                                       — must 403
 *
 * Mission goals 1, 2, 3, 8: real funding, matched to actual needs, never zero.
 */

import { getDb } from '../backend/db/index.js'
import { generateApiKey } from '../backend/middleware/schoolPortalAuth.js'
import crypto from 'node:crypto'

const BASE = process.env.SCHOOL_PORTAL_VERIFY_BASE || 'http://localhost:3911'

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, body: json }
}

async function main() {
  console.log(`[verify] base = ${BASE}`)
  const db = await getDb()

  // 1) Seed a partner + key directly so we don't need an admin login.
  const slug = `verify-${Date.now()}`
  const name = `Verify University ${Date.now()}`
  const partnerId = crypto.randomUUID()
  await db
    .prepare(`INSERT INTO school_partners (id, slug, name, status, allowed_origins, metadata)
              VALUES (?, ?, ?, 'active', '[]', '{}')`)
    .run(partnerId, slug, name)

  const key = generateApiKey()
  const keyId = crypto.randomUUID()
  await db
    .prepare(`INSERT INTO school_partner_api_keys
                (id, school_partner_id, key_hash, key_prefix, label)
              VALUES (?, ?, ?, ?, 'verify-script')`)
    .run(keyId, partnerId, key.hash, key.prefix)

  const auth = `Bearer ${key.raw}`
  console.log(`[verify] seeded partner ${slug} (${partnerId}) with key ${key.prefix}…`)

  // 2) Sync 2 students.
  const sync = await call('POST', '/api/school-portal/students/sync', {
    students: [
      {
        external_student_id: `STU-${Date.now()}-A`,
        school_email: `alice.${Date.now()}@${slug}.edu`,
        full_name: 'Alice Verify',
        student_level: 'Undergraduate',
        primary_major: 'Nursing',
        cumulative_gpa: 3.42,
        enrollment_status: 'full_time',
        home_state: 'TN',
        zip_code: '38103',
        is_pell_eligible: true,
        is_first_generation: true,
        fafsa_efc: 0,
      },
      {
        external_student_id: `STU-${Date.now()}-B`,
        school_email: `bob.${Date.now()}@${slug}.edu`,
        full_name: 'Bob Verify',
        student_level: 'Graduate',
        primary_major: 'Computer Science',
        cumulative_gpa: 3.85,
        enrollment_status: 'part_time',
        home_state: 'CA',
      },
    ],
  }, { Authorization: auth })

  console.log(`[verify] sync -> status=${sync.status} ok=${sync.body.ok} succeeded=${sync.body.succeeded} failed=${sync.body.failed}`)
  if (sync.status !== 200 || !sync.body.ok) {
    console.error('[verify] sync body:', JSON.stringify(sync.body, null, 2))
    process.exit(2)
  }
  const [aliceResult, bobResult] = sync.body.results

  // 3) /me sanity
  const me = await call('GET', '/api/school-portal/me', null, { Authorization: auth })
  console.log(`[verify] me -> ${me.body.partner?.slug} student_links=${me.body.student_link_count}`)
  if (me.body.student_link_count !== 2) {
    console.error('[verify] FAIL: expected 2 student links')
    process.exit(3)
  }

  // 4) Snapshot
  const snap = await call('GET', `/api/school-portal/students/${aliceResult.external_student_id}`, null, { Authorization: auth })
  console.log(`[verify] snapshot Alice -> primary_type=${snap.body.profile?.primary_type} sections=${Object.keys(snap.body.profile?.sections ?? {}).length}`)

  // 5) Matches
  const matches = await call('GET', `/api/school-portal/students/${aliceResult.external_student_id}/matches?limit=10`, null, { Authorization: auth })
  console.log(`[verify] matches Alice -> total_found=${matches.body.total_found} included=${matches.body.included}`)
  if ((matches.body.included ?? 0) === 0) {
    console.error('[verify] FAIL: zero matches surfaced for newly-merged student profile')
    console.error(JSON.stringify(matches.body, null, 2))
    process.exit(4)
  }
  for (const m of (matches.body.matches || []).slice(0, 3)) {
    console.log(`  - score=${m.score?.toFixed?.(2) ?? m.score} ${m.title}`)
  }

  // 6) Revoke
  const revoke = await call('POST', `/api/school-portal/students/${aliceResult.external_student_id}/revoke`, null, { Authorization: auth })
  console.log(`[verify] revoke Alice -> status=${revoke.status} revoked=${revoke.body.revoked}`)

  // 7) Matches must now 403
  const blocked = await call('GET', `/api/school-portal/students/${aliceResult.external_student_id}/matches`, null, { Authorization: auth })
  console.log(`[verify] matches after revoke -> status=${blocked.status} code=${blocked.body.code}`)
  if (blocked.status !== 403 || blocked.body.code !== 'CONSENT_REVOKED') {
    console.error('[verify] FAIL: revoked link should return 403 CONSENT_REVOKED')
    process.exit(5)
  }

  console.log('\n[verify] OK: school-portal bridge end-to-end')
}

main().catch((err) => {
  console.error('[verify] FAIL:', err.message)
  console.error(err.stack)
  process.exit(1)
})
