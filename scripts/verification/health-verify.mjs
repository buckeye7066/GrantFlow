#!/usr/bin/env node
/**
 * Health feature end-to-end verification (local):
 * - create a health-eligible profile in VERIFY_DB
 * - enqueue health_resources crawler job via /api/crawlers/jobs
 * - wait for job completion
 * - query DB for durable funding_opportunities inserted by health_resources_crawler
 *
 * Env:
 * - VERIFY_BACKEND_BASE_URL (default http://127.0.0.1:19181)
 * - VERIFY_ADMIN_TOKEN (default verify-admin-token)
 * - VERIFY_DB_PATH (default backend/data/grantflow.verify.db)
 */
import process from 'node:process'
import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'

const BASE = process.env.VERIFY_BACKEND_BASE_URL || 'http://127.0.0.1:19181'
const TOKEN = process.env.VERIFY_ADMIN_TOKEN || 'verify-admin-token'
const DB_PATH = process.env.VERIFY_DB_PATH || 'backend/data/grantflow.verify.db'

function authHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  }
}

async function fetchJson(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

function createHealthProfileInDb() {
  const db = new Database(DB_PATH)
  const id = crypto.randomUUID()
  db.prepare(
    'INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by) VALUES (?,?,?,?,?,?)',
  ).run(id, 'Health Demo Profile (verify)', 'individual_need', 'active', JSON.stringify(['health', 'medical']), 'admin')
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?,?,?,?)').run(
    id,
    'basic_information',
    JSON.stringify({ full_name: 'Health Demo Profile (verify)', state: 'TN', zip: '37209', email: 'health.demo@example.com' }),
    'seed',
  )
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?,?,?,?)').run(
    id,
    'health_medical',
    JSON.stringify({
      conditions: [{ name: 'Epilepsy' }],
      support_needs: ['transportation', 'copay_assistance'],
      consent_for_studies: true,
      notes: 'Informational only',
    }),
    'seed',
  )
  db.close()
  return id
}

async function run() {
  const profileId = createHealthProfileInDb()

  const createJob = await fetchJson('/api/crawlers/jobs', {
    method: 'POST',
    body: { type: 'health_resources', profile_id: profileId, parameters: { include_trials: true }, force: true },
  })
  if (!(createJob.status === 200 || createJob.status === 201) || !createJob.json?.id) {
    throw new Error(`Failed to create health_resources job: ${createJob.status} ${JSON.stringify(createJob.json)}`)
  }
  const jobId = String(createJob.json.id)

  let job = createJob.json
  for (let i = 0; i < 240; i += 1) {
    const res = await fetchJson(`/api/crawlers/jobs/${encodeURIComponent(jobId)}`)
    if (res.status === 200) job = res.json
    const st = String(job?.status || '')
    if (st === 'completed' || st === 'failed' || st === 'cancelled') break
    // eslint-disable-next-line no-await-in-loop
    await delay(500)
  }

  const db = new Database(DB_PATH, { readonly: true })
  const inserted = db
    .prepare(
      `
        SELECT COUNT(*) AS n
        FROM funding_opportunities
        WHERE source = 'health_resources_crawler'
      `,
    )
    .get()
  const sample = db
    .prepare(
      `
        SELECT id, title, sponsor, opportunity_type, state, source_url, application_url, created_at
        FROM funding_opportunities
        WHERE source = 'health_resources_crawler'
        ORDER BY created_at DESC
        LIMIT 10
      `,
    )
    .all()
  db.close()

  console.log(
    JSON.stringify(
      {
        ok: true,
        backend: BASE,
        profile_id: profileId,
        crawler_job: { id: jobId, status: job?.status, result_count: job?.result_count ?? null, error: job?.error ?? null },
        db_evidence: {
          inserted_count: Number(inserted?.n || 0),
          inserted_sample: sample,
        },
      },
      null,
      2,
    ),
  )
}

run().catch((err) => {
  console.error('[health-verify] failed:', err?.stack || err)
  process.exit(1)
})

