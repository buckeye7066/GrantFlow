import fs from 'node:fs'
import path from 'node:path'

const BASE_URL = 'https://app.axiombiolabs.org'
const EXPECTED_SHA = '12ee0af3be440c093f0daf50eedd573d504ee317'
const PROFILE_IDS = [
  'profile-hollie-knox',
  '6b3c75ec-dc56-46f9-b380-394172688175',
  'c4a92724-9cee-416f-ba30-e91b9b5cd885',
  'profile-olivia-beltran',
  'profile-john-white',
]
const OUT_DIR = path.resolve('audit-dist')

async function request(pathname, { admin = false } = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      ...(admin ? { 'x-admin-token': String(process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || '') } : {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${body?.error || 'request failed'}`)
  return body
}

const fresh = Date.now()
const build = await request(`/api/meta/build?fresh=${fresh}`)
if (build?.sha !== EXPECTED_SHA) throw new Error(`deployed SHA mismatch: ${build?.sha || 'missing'}`)
const params = new URLSearchParams({ profiles: PROFILE_IDS.join(','), match_limit: '1000' })
const snapshot = await request(`/api/admin/queue/production-audit/snapshot?${params}`, { admin: true })
const rows = Array.isArray(snapshot?.matches?.rows) ? snapshot.matches.rows : []
const resourceNonReview = rows.filter((row) => row.visible === true && row.is_resource === true && row.match_decision !== 'review')
const directRejects = rows.filter((row) => row.visible === true && row.is_resource !== true && row.match_decision === 'reject')
const relabelledRejects = rows.filter((row) => row.visible === true && row.canonical_decision === 'reject' && row.match_decision !== 'reject')
const compact = (row) => ({
  profile_id: row.profile_id,
  opportunity_id: row.opportunity_id,
  title: row.title,
  sponsor: row.sponsor,
  opportunity_kind: row.opportunity_kind,
  match_score: row.match_score,
  match_decision: row.match_decision,
  canonical_decision: row.canonical_decision,
  matcher_version: row.matcher_version,
})
const result = {
  audit: 'grantflow-final-audit-finding-inspection-v2',
  expected_sha: EXPECTED_SHA,
  generated_at: new Date().toISOString(),
  resource_non_review: resourceNonReview.map(compact),
  visible_direct_rejects: directRejects.map(compact),
  canonical_reject_relabelled: relabelledRejects.map(compact),
  integrity_by_profile: snapshot?.matches?.integrity_by_profile || {},
  totals: snapshot?.matches?.totals || {},
  values_exposed: false,
}
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'findings.json'), JSON.stringify(result, null, 2) + '\n')
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), '<!doctype html><meta charset="utf-8"><title>GrantFlow audit findings</title><pre>See findings.json</pre>')

const categories = [
  ['resource_non_review', result.resource_non_review],
  ['visible_direct_rejects', result.visible_direct_rejects],
  ['canonical_reject_relabelled', result.canonical_reject_relabelled],
]
console.log(`[final-audit-findings] SUMMARY ${JSON.stringify({
  audit: result.audit,
  expected_sha: result.expected_sha,
  counts: Object.fromEntries(categories.map(([name, entries]) => [name, entries.length])),
  totals: result.totals,
  integrity_by_profile: result.integrity_by_profile,
})}`)
for (const [category, entries] of categories) {
  for (const [index, entry] of entries.entries()) {
    console.log(`[final-audit-findings] ${category} ${index + 1}/${entries.length} ${JSON.stringify(entry)}`)
  }
}
