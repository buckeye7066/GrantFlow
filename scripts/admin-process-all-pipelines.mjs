#!/usr/bin/env node
/**
 * scripts/admin-process-all-pipelines.mjs
 *
 * For every profile, enqueue a `pipeline_automation` job that lets Anya walk
 * each grant through the automatable stages and STOP at the human-required
 * submission boundary:
 *
 *   discovered → interested → drafting → application_prep → revision
 *               ↓
 *   portal      (federal/state/foundation portal — human applies online)
 *   submitted   (private foundation accepting email/mail — human prints + mails)
 *   pending_review (already submitted — awaiting funder)
 *
 * The AI prompt at backend/prompts/pipelineAutomation.js explicitly forbids
 * advancing past those three stages without human action — that IS the
 * boundary the user asked us to stop at.
 *
 * Required env: GF_API, GF_TOKEN
 * Optional env:
 *   GF_POLL_INTERVAL_MS   default 10000
 *   GF_MAX_WAIT_MS        default 30 * 60 * 1000  (30 min hard cap)
 *   GF_GRANT_LIMIT        default 200             (per-profile cap)
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) {
  console.error('Missing GF_API or GF_TOKEN')
  process.exit(2)
}
const POLL_MS = Number(process.env.GF_POLL_INTERVAL_MS ?? '10000')
const MAX_WAIT_MS = Number(process.env.GF_MAX_WAIT_MS ?? String(30 * 60 * 1000))
const GRANT_LIMIT = Number(process.env.GF_GRANT_LIMIT ?? '200')

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, init = {}, { tries = 3 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
      return { ok: res.ok, status: res.status, body }
    } catch (e) {
      lastErr = e
      await sleep(500 * (i + 1))
    }
  }
  return { ok: false, status: 0, body: { error: String(lastErr?.message || lastErr) } }
}

async function listProfiles() {
  const r = await fetchJson(`${API}/profiles?limit=500`)
  if (!r.ok) throw new Error(`profiles list failed: ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`)
  return r.body
}

async function enqueueAutomation(profileId) {
  const body = {
    type: 'pipeline_automation',
    profile_id: profileId,
    parameters: {
      process_all: true,
      limit: GRANT_LIMIT,
    },
  }
  const r = await fetchJson(`${API}/crawlers/jobs`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return r
}

async function getJob(jobId) {
  return fetchJson(`${API}/crawlers/jobs/${encodeURIComponent(jobId)}`)
}

async function getPipelineCounts(profileId) {
  const r = await fetchJson(`${API}/grants/pipeline?profile_id=${encodeURIComponent(profileId)}`)
  if (!r.ok) return null
  const buckets = ['discovered','interested','drafting','app_prep','application_prep','revision','portal','submitted','pending_review','follow_up','awarded','report','declined','declined_no_review','closed','rejected']
  const counts = {}
  let total = 0
  for (const b of buckets) {
    const n = Array.isArray(r.body?.[b]) ? r.body[b].length : 0
    if (n > 0) counts[b] = n
    total += n
  }
  return { total, counts }
}

function fmt(o) { return JSON.stringify(o, null, 2) }

async function main() {
  const startedAt = new Date().toISOString()
  console.log(`[run] started ${startedAt}; api=${API}; per-profile-limit=${GRANT_LIMIT}`)

  const profiles = await listProfiles()
  console.log(`[run] ${profiles.length} profiles`)

  // Snapshot pre-state for every profile
  const before = {}
  for (const p of profiles) {
    before[p.id] = await getPipelineCounts(p.id) || { total: 0, counts: {} }
  }

  // Enqueue one pipeline_automation job per profile
  const queued = []
  for (const p of profiles) {
    const r = await enqueueAutomation(p.id)
    if (r.status === 201 || r.status === 200) {
      queued.push({
        profile_id: p.id,
        display_name: p.display_name,
        primary_type: p.primary_type,
        job_id: r.body?.id ?? r.body?.jobId ?? null,
        existing: r.status === 200,
        before_total: before[p.id].total,
        before_counts: before[p.id].counts,
      })
      console.log(`  + ${p.display_name.padEnd(36)} → job ${r.body?.id ?? '?'} (${r.status === 200 ? 'reused' : 'new'}, before_total=${before[p.id].total})`)
    } else {
      console.warn(`  ! ${p.display_name}: enqueue failed (${r.status}): ${JSON.stringify(r.body).slice(0, 220)}`)
      queued.push({
        profile_id: p.id,
        display_name: p.display_name,
        primary_type: p.primary_type,
        job_id: null,
        enqueue_error: r.body?.error ?? r.body?.message ?? `status ${r.status}`,
        before_total: before[p.id].total,
        before_counts: before[p.id].counts,
      })
    }
  }

  console.log(`[run] enqueued ${queued.filter(q => q.job_id).length} of ${queued.length} jobs; polling every ${POLL_MS}ms`)

  // Poll until every job is terminal (completed | failed | cancelled) or we hit MAX_WAIT_MS
  const pollDeadline = Date.now() + MAX_WAIT_MS
  const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
  const lastSeen = new Map()
  while (Date.now() < pollDeadline) {
    let pending = 0
    for (const q of queued) {
      if (!q.job_id) { q.terminal = true; continue }
      if (q.terminal) continue
      const r = await getJob(q.job_id)
      const status = r.body?.status ?? 'unknown'
      const meta = r.body?.result_meta ?? r.body?.resultMeta ?? null
      q.last_status = status
      q.last_meta = meta
      q.error = r.body?.error ?? null
      if (TERMINAL.has(status)) {
        q.terminal = true
      } else {
        pending++
      }
      const sig = `${q.job_id}:${status}:${meta?.advanced ?? ''}`
      if (lastSeen.get(q.job_id) !== sig) {
        lastSeen.set(q.job_id, sig)
        console.log(`  [${new Date().toISOString().slice(11,19)}] ${q.display_name.padEnd(36)} ${status.padEnd(10)} ${meta ? `evaluated=${meta.evaluated} advanced=${meta.advanced} handoffs=${meta.handoffs}` : ''}`)
      }
    }
    if (pending === 0) break
    await sleep(POLL_MS)
  }

  // Snapshot post-state
  const after = {}
  for (const p of profiles) {
    after[p.id] = await getPipelineCounts(p.id) || { total: 0, counts: {} }
  }

  // Build summary
  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    api: API,
    per_profile_limit: GRANT_LIMIT,
    totals: {
      profiles: queued.length,
      jobs_enqueued: queued.filter(q => q.job_id).length,
      jobs_completed: queued.filter(q => q.last_status === 'completed').length,
      jobs_failed: queued.filter(q => q.last_status === 'failed').length,
      jobs_pending_at_timeout: queued.filter(q => q.job_id && !q.terminal).length,
      grants_evaluated: queued.reduce((s, q) => s + (q.last_meta?.evaluated ?? 0), 0),
      grants_advanced: queued.reduce((s, q) => s + (q.last_meta?.advanced ?? 0), 0),
      grants_handoff: queued.reduce((s, q) => s + (q.last_meta?.handoffs ?? 0), 0),
    },
    per_profile: queued.map(q => ({
      profile_id: q.profile_id,
      display_name: q.display_name,
      primary_type: q.primary_type,
      job_id: q.job_id,
      job_status: q.last_status ?? null,
      job_error: q.error,
      enqueue_error: q.enqueue_error ?? null,
      grants_evaluated: q.last_meta?.evaluated ?? 0,
      grants_advanced: q.last_meta?.advanced ?? 0,
      grants_handoff: q.last_meta?.handoffs ?? 0,
      before: { total: q.before_total, counts: q.before_counts },
      after: after[q.profile_id],
    })),
  }

  // Pretty-print summary
  console.log('\n========== SUMMARY ==========')
  console.log(fmt(summary.totals))
  console.log('\nPer-profile pipeline shift (BEFORE → AFTER):')
  console.log('PROFILE                              EVAL ADV HOFF  STATUSES')
  console.log('-'.repeat(110))
  for (const p of summary.per_profile) {
    const before = Object.entries(p.before?.counts ?? {}).map(([k,v]) => `${k}:${v}`).join(',') || '-'
    const after = Object.entries(p.after?.counts ?? {}).map(([k,v]) => `${k}:${v}`).join(',') || '-'
    console.log(`${(p.display_name||'').padEnd(36).slice(0,36)} ${String(p.grants_evaluated).padStart(4)} ${String(p.grants_advanced).padStart(3)} ${String(p.grants_handoff).padStart(4)}  ${before} → ${after}`)
  }

  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  const stamp = startedAt.replace(/[:.]/g, '-')
  const out = path.join('docs/_readiness_logs', `process-all-pipelines_${stamp}.json`)
  await fs.writeFile(out, JSON.stringify(summary, null, 2), 'utf8')
  console.log(`\nWrote → ${out}`)
}

main().catch(e => { console.error('FATAL:', e?.stack || e?.message || e); process.exit(1) })
