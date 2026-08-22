/**
 * hamiltonPortalQuirkObserver.js
 *
 * The "teach Anya to LOOK" half of the quirk loop (owner 2026-08-22). Reads
 * Hamilton's own recorded failures (hamilton_autopilot_runs: blocker_kind,
 * blocker_detail, joined to the portal host) and routes each cluster:
 *
 *   LANE 1 (autonomous): a quirk it can confidently express as DATA — an
 *   eligibility/age/attestation checkbox on a host — is written straight to the
 *   quirk registry (validated, data-only) so Hamilton clears it next run.
 *
 *   LANE 2 (human-approved): a signature recurring ACROSS many hosts needs a
 *   general CODE capability. Anya NEVER self-merges — she appends a code brief
 *   to `system_kv hamilton_quirk_code_briefs` (the owner's morning report reads
 *   it) with a plain-English explanation and `patch_authored_by_anya:false`. The
 *   owner approves on next login, which dispatches through anyaCodeFixDispatch.
 *
 * Nothing here writes code or runs a browser. Lane 1 is data; Lane 2 is a
 * proposal a human must accept.
 */

import { createLogger } from '../../utils/logger.js'
import { recordObservedQuirk, setQuirkHandler, quirkSignature, hostKey } from './hamiltonPortalQuirkRegistry.js'

const log = createLogger('service:hamilton-quirk-observer')

const AGE_RX = /\b(?:\d{1,2}\s*years?\s*old|or older|at least\s*\d{1,2}|age of majority|under\s*\d{1,2})\b/i
const CITIZEN_RX = /\b(?:u\.?s\.?\s*citizen|citizen or (?:legal|permanent)|permanent resident|lawful(?:ly)? present|eligible to (?:work|study))\b/i
const ENROLL_RX = /\b(?:enrolled|full[- ]?time|part[- ]?time|attending|currently a student)\b/i
const AGREE_RX = /\b(?:i (?:agree|certify|confirm|acknowledge|understand)|true and accurate|terms and conditions|to the best of my knowledge|privacy policy)\b/i
const CHECKBOX_HINT_RX = /\bcheck (?:this|the) box\b|\bplease check\b|\bfield is required\b|\bmust (?:be )?(?:checked|selected)\b|\brequired\b/i

/**
 * Classify a blocked-run detail into a Lane-1 data handler, if it clearly is one.
 * Pure + deterministic. Returns a validated-shape handler or null.
 */
export function classifyQuirk(blockerKind, detail) {
  const text = String(detail || '')
  const kind = String(blockerKind || '').toLowerCase()
  // Only VALIDATION blocks (a required control the browser refused to submit)
  // yield a checkbox data-rule. A login/captcha/etc. is a different lane.
  if (kind !== 'validation') return null
  if (!CHECKBOX_HINT_RX.test(text) && !AGE_RX.test(text) && !AGREE_RX.test(text)) return null
  // Use the leading clause as the match anchor (the checkbox's own label).
  const match = text.split(/[|:]/)[0].replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!match) return null
  if (AGE_RX.test(text)) return { kind: 'checkbox_rule', match, action: 'age_affirmation' }
  if (CITIZEN_RX.test(text) || ENROLL_RX.test(text)) return { kind: 'checkbox_rule', match, action: 'eligibility_affirmation' }
  if (AGREE_RX.test(text)) return { kind: 'checkbox_rule', match, action: 'attestation_agree' }
  return null
}

/** Load recent blocked runs joined to their portal host (best-effort, prod schema). */
export async function loadBlockedRunsForObservation(db, { limit = 300 } = {}) {
  const rows = await db.prepare(
    `SELECT r.blocker_kind AS blocker_kind, r.blocker_detail AS blocker_detail,
            COALESCE(fo.application_url, fo.source_url, g.url, g.application_url) AS url
       FROM hamilton_autopilot_runs r
       LEFT JOIN application_tasks t ON t.id = r.task_id
       LEFT JOIN funding_opportunities fo ON fo.id = t.opportunity_id
       LEFT JOIN grants g ON g.id = t.grant_id
      WHERE r.status = 'blocked' AND r.blocker_detail IS NOT NULL
      ORDER BY r.created_at DESC
      LIMIT ?`,
  ).all(limit).catch(() => [])
  return (rows || []).map((r) => ({ host: hostKey(r.url), blocker_kind: r.blocker_kind, detail: r.blocker_detail }))
    .filter((r) => r.host)
}

const CROSS_HOST_KV_KEY = 'hamilton_quirk_code_briefs'

async function appendCodeBrief(db, brief) {
  const isPg = db?.dialect === 'postgres'
  const now = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(CROSS_HOST_KV_KEY).catch(() => null)
  let list = []
  try { list = row?.value ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : [] } catch { list = [] }
  if (!Array.isArray(list)) list = []
  // Dedup by signature — a recurring pattern is ONE standing brief, not N.
  if (list.some((b) => b.signature === brief.signature)) return false
  list.push(brief)
  const data = JSON.stringify(list.slice(-100))
  const existing = await db.prepare('SELECT 1 AS x FROM system_kv WHERE key = ?').get(CROSS_HOST_KV_KEY).catch(() => null)
  if (existing) await db.prepare(`UPDATE system_kv SET value = ?, updated_at = ${now} WHERE key = ?`).run(data, CROSS_HOST_KV_KEY)
  else await db.prepare('INSERT INTO system_kv (key, value) VALUES (?, ?)').run(CROSS_HOST_KV_KEY, data)
  return true
}

/**
 * The sweep. Records every observed quirk, writes Lane-1 handlers for the ones
 * that are clearly data, and raises a Lane-2 code brief for any signature that
 * recurs across >= minCrossHost distinct hosts (a general capability is due).
 *
 * @param {object} db
 * @param {{ runs?: Array, minCrossHost?: number, applyLane1?: boolean }} opts
 *   `runs` may be injected (tests); otherwise loaded from the DB.
 * @returns {{ observed, lane1_written, lane2_briefs }}
 */
export async function observePortalQuirks(db, { runs = null, minCrossHost = 3, applyLane1 = true } = {}) {
  const list = Array.isArray(runs) ? runs : await loadBlockedRunsForObservation(db)
  let observed = 0
  let lane1Written = 0
  for (const r of list) {
    if (!r?.host) continue
    await recordObservedQuirk(db, { host: r.host, blockerKind: r.blocker_kind, sample: r.detail }).catch(() => {})
    observed += 1
    if (applyLane1) {
      const handler = classifyQuirk(r.blocker_kind, r.detail)
      if (handler) {
        const res = await setQuirkHandler(db, r.host, handler, { source: 'anya_observer' }).catch(() => ({ ok: false }))
        if (res?.ok) lane1Written += 1
      }
    }
  }
  // Cross-host clustering → Lane 2 briefs.
  const lane2 = []
  const clusters = await db.prepare(
    `SELECT signature, COUNT(DISTINCT host) AS hosts, MAX(sample) AS sample, MAX(blocker_kind) AS blocker_kind
       FROM hamilton_portal_quirk_encounters
      GROUP BY signature HAVING COUNT(DISTINCT host) >= ?`,
  ).all(minCrossHost).catch(() => [])
  for (const c of clusters || []) {
    const brief = {
      signature: c.signature,
      hosts: Number(c.hosts),
      blocker_kind: c.blocker_kind,
      sample: String(c.sample || '').slice(0, 300),
      explanation: `Hamilton is blocked by the same "${String(c.blocker_kind || 'portal')}" quirk on ${c.hosts} different portals: "${String(c.sample || '').slice(0, 120)}". This recurs across hosts, so it warrants a general capability (like the age-affirmation evaluator), not a per-host rule. Anya proposes a code change; approve it to dispatch through anyaCodeFixDispatch.`,
      patch_authored_by_anya: false,
      created_marker: 'anya_quirk_observer',
    }
    const added = await appendCodeBrief(db, brief).catch(() => false)
    if (added) lane2.push(brief)
  }
  log.info('quirk_observer_sweep', { observed, lane1_written: lane1Written, lane2_new: lane2.length })
  return { observed, lane1_written: lane1Written, lane2_briefs: lane2 }
}

export const _internal = { classifyQuirk, quirkSignature, CROSS_HOST_KV_KEY }
