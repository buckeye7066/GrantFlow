#!/usr/bin/env node
/**
 * scripts/admin-purge-loan-grants.mjs
 *
 * Mission rule: GrantFlow never recommends funding sources that require
 * repayment. Earlier work (demo_stem_student-add-offcampus-living-funding.mjs and
 * the first cut of the studentBridgeFunding catalog) accidentally added
 * the Federal Direct Subsidized Loan (and possibly other loan-shaped
 * entries) to profile pipelines.
 *
 * This script:
 *   1. Scans every grant in every profile pipeline via /api/grants
 *   2. Flags any grant whose title / funder / notes / application_url
 *      contains loan-shaped language (loan, repay, interest rate, etc.)
 *   3. Deletes each flagged grant via DELETE /api/grants/:id
 *   4. Writes a JSON audit log so the purge is reversible / auditable
 *
 * Required env: GF_API, GF_TOKEN (admin token)
 *
 * Usage:
 *   GF_API=... GF_TOKEN=... node scripts/admin-purge-loan-grants.mjs
 *   node scripts/admin-purge-loan-grants.mjs --dry-run    (report only, no deletes)
 *   node scripts/admin-purge-loan-grants.mjs --profile=<id>
 */
import fs from 'node:fs/promises'

const API = process.env.GF_API
const TOKEN = process.env.GF_TOKEN
if (!API || !TOKEN) { console.error('Missing GF_API or GF_TOKEN'); process.exit(2) }

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const DRY_RUN = Boolean(args['dry-run'])
const ONLY_PROFILE = args.profile && typeof args.profile === 'string' ? args.profile : null

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

const LOAN_PATTERNS = [
  /\bloan\b/i,
  /\bsubsidized loan\b/i,
  /\bunsubsidized loan\b/i,
  /\bdirect plus\b/i,
  /\bgrad plus\b/i,
  /\bparent plus\b/i,
  /\bperkins\b/i,
  /\binterest rate\b/i,
  /\bmonthly payment\b/i,
  /\brepay\b/i,
  /\bborrow\b/i,
  /\bcosigner\b/i,
  /\bincome[- ]share agreement\b/i,
  /studentaid\.gov\/.*loan/i,
]

function isLoanShaped(grant) {
  const haystack = [grant.title, grant.funder, grant.notes, grant.application_url]
    .filter(Boolean)
    .map((s) => String(s))
    .join(' \n ')
  return LOAN_PATTERNS.some((re) => re.test(haystack))
}

async function listProfiles() {
  if (ONLY_PROFILE) {
    const r = await fetchJson(`${API}/profiles/${ONLY_PROFILE}`)
    if (!r.ok) { console.error(`failed to load ${ONLY_PROFILE}: ${r.status}`); process.exit(1) }
    return [r.body]
  }
  const out = []
  let page = 1
  while (true) {
    const r = await fetchJson(`${API}/profiles?limit=200&offset=${(page - 1) * 200}`)
    if (!r.ok) break
    const rows = Array.isArray(r.body) ? r.body : r.body?.items || []
    if (rows.length === 0) break
    out.push(...rows)
    if (rows.length < 200) break
    page += 1
  }
  return out
}

async function main() {
  const profiles = await listProfiles()
  console.log(`[purge-loans] scanning ${profiles.length} profile(s) ${DRY_RUN ? '(DRY RUN)' : ''}`)

  const audit = { dry_run: DRY_RUN, scanned_profiles: 0, flagged: [], deleted: [], delete_failures: [] }
  let totalFlagged = 0
  let totalDeleted = 0

  for (const p of profiles) {
    audit.scanned_profiles += 1
    const r = await fetchJson(`${API}/grants?profile_id=${p.id}&limit=2000`)
    if (!r.ok) {
      console.warn(`  [${p.id}] could not list grants: ${r.status}`)
      continue
    }
    const grants = Array.isArray(r.body) ? r.body : r.body?.items || []
    const flagged = grants.filter(isLoanShaped)
    if (flagged.length === 0) continue
    totalFlagged += flagged.length
    console.log(`  [${p.id}] ${p.display_name || p.name || ''}: ${flagged.length} loan-shaped grant(s)`)
    for (const g of flagged) {
      const reason = LOAN_PATTERNS.find((re) =>
        re.test([g.title, g.funder, g.notes, g.application_url].filter(Boolean).join(' '))
      )
      const flag = {
        profile_id: p.id,
        profile_name: p.display_name || p.name || null,
        grant_id: g.id,
        title: g.title,
        funder: g.funder,
        application_url: g.application_url,
        status: g.status,
        matched_pattern: String(reason ?? ''),
      }
      audit.flagged.push(flag)
      console.log(`    - ${g.id?.slice(0, 8) ?? '?'}  ${(g.title || '').slice(0, 80)}  [${flag.matched_pattern}]`)
      if (DRY_RUN) continue
      const del = await fetchJson(`${API}/grants/${g.id}`, { method: 'DELETE' })
      if (del.status === 200 || del.status === 204) {
        totalDeleted += 1
        audit.deleted.push(flag)
      } else {
        audit.delete_failures.push({ ...flag, status: del.status, body: del.body })
        console.warn(`      ! delete failed (${del.status}): ${JSON.stringify(del.body).slice(0, 200)}`)
      }
    }
  }

  console.log(`\n[purge-loans] flagged=${totalFlagged} deleted=${totalDeleted} ${DRY_RUN ? '(dry run — no deletes performed)' : ''}`)

  await fs.mkdir('docs/_readiness_logs', { recursive: true })
  await fs.writeFile(
    'docs/_readiness_logs/purge-loan-grants.json',
    JSON.stringify(audit, null, 2),
    'utf8',
  )
  console.log(`Wrote → docs/_readiness_logs/purge-loan-grants.json`)
}

main().catch((e) => { console.error('FATAL', e?.stack || e?.message || e); process.exit(1) })
