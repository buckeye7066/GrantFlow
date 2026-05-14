#!/usr/bin/env node
/**
 * scripts/admin-run-student-bridge-funding.mjs
 *
 * Enqueue a `student_bridge_funding` job for one specific profile (when
 * --profile=<id> is passed) or for every student-tagged profile in the
 * org-listing endpoint. Polls each job to completion and prints a
 * one-line summary per profile.
 *
 * Required env: GF_API, GF_TOKEN
 *
 * Usage:
 *   GF_API=... GF_TOKEN=... node scripts/admin-run-student-bridge-funding.mjs
 *   node scripts/admin-run-student-bridge-funding.mjs --profile=<uuid>
 *   node scripts/admin-run-student-bridge-funding.mjs --limit=5
 */
import fs from 'node:fs/promises'

const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) {
  console.error('Missing GF_API or GF_TOKEN')
  process.exit(2)
}

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.replace(/^--/, '').split('='))
    .filter((p) => p.length === 2),
)

const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, init = {}, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } })
      const t = await r.text()
      let body
      try { body = t ? JSON.parse(t) : {} } catch { body = { raw: t } }
      return { ok: r.ok, status: r.status, body }
    } catch (e) { last = e; await sleep(400 * (i + 1)) }
  }
  return { ok: false, status: 0, body: { error: String(last?.message || last) } }
}

function isStudentProfile(p) {
  const pt = String(p?.primary_type || '').toLowerCase()
  if (pt.includes('student') || pt.includes('high_school') || pt.includes('college') || pt.includes('graduate')) return true
  const tags = Array.isArray(p?.tags) ? p.tags : []
  return tags.some((t) => /student|college|university|scholarship|education/i.test(String(t)))
}

async function listStudentProfiles(limit) {
  const out = []
  // /api/admin/profiles is the canonical admin listing; fall back to /profiles.
  let page = 1
  while (out.length < limit) {
    const r = await fetchJson(`${API}/profiles?limit=200&offset=${(page - 1) * 200}`)
    if (!r.ok) {
      if (page === 1) console.warn(`Could not list profiles via /profiles: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
      break
    }
    const rows = Array.isArray(r.body) ? r.body : r.body?.items || []
    if (rows.length === 0) break
    for (const p of rows) {
      if (isStudentProfile(p)) out.push(p)
      if (out.length >= limit) break
    }
    if (rows.length < 200) break
    page += 1
  }
  return out
}

async function enqueueJob(profileId) {
  const r = await fetchJson(`${API}/crawlers/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'student_bridge_funding',
      profile_id: profileId,
      parameters: {},
      force: true,
    }),
  })
  if (r.status !== 200 && r.status !== 201) {
    return { ok: false, error: `enqueue ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` }
  }
  return { ok: true, jobId: r.body?.id }
}

async function pollJob(jobId, timeoutMs = 180_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(2000)
    const r = await fetchJson(`${API}/crawlers/jobs/${jobId}`)
    if (!r.ok) continue
    const status = r.body?.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return r.body
  }
  return { status: 'timeout', id: jobId }
}

async function main() {
  const profiles = []
  if (args.profile) {
    const r = await fetchJson(`${API}/profiles/${args.profile}`)
    if (!r.ok) { console.error(`Could not load profile ${args.profile}: ${r.status}`); process.exit(1) }
    profiles.push(r.body)
  } else {
    const limit = parseInt(args.limit || '50', 10)
    const candidates = await listStudentProfiles(limit)
    profiles.push(...candidates)
    console.log(`Found ${profiles.length} student-tagged profiles`)
  }

  const summary = []
  for (const p of profiles) {
    const id = p.id
    const name = p.display_name || p.name || id
    process.stdout.write(`\n[${id}] ${name} ... `)
    const enq = await enqueueJob(id)
    if (!enq.ok) { console.log(`enqueue failed: ${enq.error}`); summary.push({ id, name, error: enq.error }); continue }
    const job = await pollJob(enq.jobId)
    const meta = (job?.result_meta && typeof job.result_meta === 'object') ? job.result_meta : (() => {
      try { return JSON.parse(job?.result_meta || '{}') } catch { return {} }
    })()
    if (job.status !== 'completed') {
      console.log(`status=${job.status}; error=${(job.error || '').slice(0, 120)}`)
      summary.push({ id, name, status: job.status, error: job.error || null })
    } else {
      console.log(
        `cycle=${meta.academic_cycle ?? '?'} school=${meta.school ?? '?'} added=${meta.added ?? 0} reused=${meta.reused ?? 0} skipped=${meta.skipped ?? 0}`,
      )
      summary.push({
        id,
        name,
        academic_cycle: meta.academic_cycle,
        school: meta.school,
        college_state: meta.college_state,
        added: meta.added,
        reused: meta.reused,
        skipped: meta.skipped,
        added_titles: meta.added_titles,
      })
    }
  }

  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  await fs.writeFile(
    'docs/_readiness_logs/student-bridge-funding.json',
    JSON.stringify(summary, null, 2),
    'utf8',
  )
  console.log(`\nWrote → docs/_readiness_logs/student-bridge-funding.json (${summary.length} profiles)`)
}

main().catch((e) => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1) })
