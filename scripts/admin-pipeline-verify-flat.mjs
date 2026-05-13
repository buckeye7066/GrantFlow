#!/usr/bin/env node
/**
 * scripts/admin-pipeline-verify-flat.mjs
 *
 * Re-verifies per-profile pipeline distribution using the FLAT endpoint that
 * the UI actually uses: GET /api/grants?profile_id=...&limit=2000
 * (the older /api/grants/pipeline grouped endpoint silently dropped grants in
 *  the newer canonical statuses — fix in this same change).
 *
 * Required env: GF_API, GF_TOKEN
 */
import fs from 'node:fs/promises'
const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) { console.error('Missing GF_API or GF_TOKEN'); process.exit(2) }
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

const HUMAN_REQUIRED = new Set(['portal','submitted','pending_review'])
const PRE_HUMAN = new Set(['discovery','discovered','interested','auto_applied','drafting','application_prep','app_prep','revision'])
const POST_HUMAN = new Set(['follow_up','awarded','report','declined','declined_no_review','rejected','closed'])

function bucketize(grants) {
  const counts = {}
  for (const g of grants) {
    const s = String(g.status || '').toLowerCase().trim() || 'unknown'
    counts[s] = (counts[s] || 0) + 1
  }
  const totals = { total: grants.length, pre_human: 0, human_required: 0, post_human: 0, unknown: 0 }
  for (const [s, n] of Object.entries(counts)) {
    if (HUMAN_REQUIRED.has(s)) totals.human_required += n
    else if (PRE_HUMAN.has(s)) totals.pre_human += n
    else if (POST_HUMAN.has(s)) totals.post_human += n
    else totals.unknown += n
  }
  return { counts, totals }
}

async function main() {
  const prof = await fetchJson(`${API}/profiles?limit=500`)
  if (!prof.ok) throw new Error(`profiles failed: ${prof.status}`)
  const profiles = prof.body
  const rows = []
  for (const p of profiles) {
    const r = await fetchJson(`${API}/grants?profile_id=${encodeURIComponent(p.id)}&limit=2000`)
    if (!r.ok) {
      rows.push({ profile: p.display_name, error: `${r.status} ${JSON.stringify(r.body).slice(0,160)}` })
      continue
    }
    const grants = Array.isArray(r.body) ? r.body : []
    const { counts, totals } = bucketize(grants)
    rows.push({
      profile_id: p.id,
      profile: p.display_name,
      ...totals,
      counts,
    })
  }
  // Print
  const fmtCounts = (c) => Object.entries(c).sort().map(([k,v]) => `${k}:${v}`).join(',')
  console.log('PROFILE                                TOTAL  PRE  HUMAN  POST  UNK  STATUSES')
  console.log('-'.repeat(140))
  let g = { total: 0, pre: 0, h: 0, post: 0, unk: 0 }
  for (const r of rows) {
    if (r.error) { console.log(`${(r.profile||'').padEnd(38)}  ERROR: ${r.error}`); continue }
    g.total += r.total; g.pre += r.pre_human; g.h += r.human_required; g.post += r.post_human; g.unk += r.unknown
    console.log(
      `${(r.profile||'').padEnd(38).slice(0,38)}  ${String(r.total).padStart(5)}  ${String(r.pre_human).padStart(3)}  ${String(r.human_required).padStart(5)}  ${String(r.post_human).padStart(4)}  ${String(r.unknown).padStart(3)}  ${fmtCounts(r.counts)}`
    )
  }
  console.log('-'.repeat(140))
  console.log(`${'TOTALS'.padEnd(38)}  ${String(g.total).padStart(5)}  ${String(g.pre).padStart(3)}  ${String(g.h).padStart(5)}  ${String(g.post).padStart(4)}  ${String(g.unk).padStart(3)}`)
  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  await fs.writeFile('docs/_readiness_logs/pipeline-verify-flat.json', JSON.stringify(rows, null, 2), 'utf8')
  console.log('\nWrote → docs/_readiness_logs/pipeline-verify-flat.json')
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1) })
