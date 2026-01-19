#!/usr/bin/env node
/**
 * Admin-safe profile de-duplication runner.
 *
 * Uses the backend admin endpoints:
 *  - GET  /api/admin/profiles/duplicates
 *  - POST /api/admin/profiles/merge
 *
 * Env:
 *  - DEDUPE_BASE_URL (preferred) or SMOKE_BASE_URL (fallback) or http://127.0.0.1:8080
 *  - ADMIN_TOKEN or ANYA_ADMIN_TOKEN (sent as X-Admin-Token)
 *
 * Usage:
 *  - node scripts/dedupe-profiles.mjs              (dry-run report)
 *  - node scripts/dedupe-profiles.mjs --apply     (apply merges that match strict safety rules)
 */

import 'dotenv/config'

const APPLY = process.argv.includes('--apply')
const MAX_MERGES = (() => {
  const idx = process.argv.indexOf('--max')
  if (idx === -1) return 25
  const val = Number(process.argv[idx + 1])
  return Number.isFinite(val) ? Math.max(1, Math.min(val, 500)) : 25
})()

const BASE_URL = (process.env.DEDUPE_BASE_URL || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

function okToAutoMergeGroup(group) {
  const winner = group?.winner
  const losers = Array.isArray(group?.losers) ? group.losers : []
  if (!winner?.id || losers.length === 0) return false

  // 1) Safe: same user_id across all candidates.
  const userIds = [winner.user_id, ...losers.map((l) => l.user_id)].filter(Boolean)
  if (userIds.length && userIds.every((id) => id === userIds[0])) return true

  // 2) Safe: same organization_id across all candidates.
  const orgIds = [winner.organization_id, ...losers.map((l) => l.organization_id)].filter(Boolean)
  if (orgIds.length && orgIds.every((id) => id === orgIds[0])) return true

  // 3) Safe: losers are truly empty shells (no sections/fields/docs/jobs/sessions/billing).
  const isEmpty = (p) =>
    (p?.section_count ?? 0) === 0 &&
    (p?.non_empty_fields ?? 0) === 0 &&
    (p?.documents ?? 0) === 0 &&
    (p?.jobs ?? 0) === 0 &&
    (p?.sessions ?? 0) === 0 &&
    (p?.billing ?? 0) === 0
  if (losers.every(isEmpty)) return true

  return false
}

async function api(path, { method = 'GET', body } = {}) {
  const url = `${BASE_URL}${path}`
  const headers = {
    'content-type': 'application/json',
  }
  if (ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${path}${text ? `: ${text.slice(0, 400)}` : ''}`)
  }
  return await res.json()
}

async function main() {
  if (!ADMIN_TOKEN) {
    console.error('[dedupe] Missing ADMIN_TOKEN/ANYA_ADMIN_TOKEN in environment. Aborting.')
    process.exitCode = 1
    return
  }

  const report = await api('/api/admin/profiles/duplicates?strategy=exact_name&limitGroups=200&minGroupSize=2')
  const groups = Array.isArray(report?.groups) ? report.groups : []
  console.log(`[dedupe] base=${BASE_URL} groups=${groups.length} apply=${APPLY}`)

  const candidates = groups.filter(okToAutoMergeGroup)
  console.log(`[dedupe] auto-merge candidates=${candidates.length} cap=${MAX_MERGES}`)

  if (!APPLY) {
    for (const g of candidates.slice(0, 25)) {
      console.log(`- ${g.key}: keep=${g.winner?.id} delete=${(g.losers || []).map((l) => l.id).join(',')}`)
    }
    return
  }

  let applied = 0
  for (const g of candidates) {
    if (applied >= MAX_MERGES) break
    const winnerId = g.winner.id
    const loserIds = (g.losers || []).map((l) => l.id).filter(Boolean)
    if (!winnerId || loserIds.length === 0) continue

    console.log(`[dedupe] merging key=${g.key} winner=${winnerId} losers=${loserIds.length}`)
    await api('/api/admin/profiles/merge', { method: 'POST', body: { winnerId, loserIds, dryRun: false } })
    applied += 1
  }

  console.log(`[dedupe] applied=${applied}`)
}

main().catch((error) => {
  console.error('[dedupe] failed:', error?.message || String(error))
  process.exitCode = 1
})

