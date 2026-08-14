/**
 * yanaHarvestVerification.js — Yana's verification pass over Robert's
 * harvested owner contacts (source='robert_contact_harvest').
 *
 * Robert only COLLECTS (name, email) pairs from the owner's mailboxes and
 * files them in Yana's lane as qualification_status='candidate'. Nothing
 * reaches John until YANA verifies each one here. A verified contact becomes
 * 'qualified' — from that point the EXISTING handoff applies unchanged:
 * pushQualifiedToJohn (with the ≤50-per-rolling-24h cap) marks it
 * pushed_to_john, and John consumes it through makeYanaLeadSource /
 * johnYanaBridge with all of John's own gates still in force.
 *
 * Verification is deterministic and DB-only (no network — fail-closed):
 *   - email must be structurally valid (isValidEmail)
 *   - BOTH fields: the stored evidence must carry a real contact name
 *   - not an excluded / non-human / list address (defense in depth — Robert
 *     already filters, Yana re-asserts independently)
 *   - not one of the owner's own addresses
 *   - not an existing GrantFlow client (users / profile_emails) — we never
 *     pitch GrantFlow to someone already on it
 *
 * A contact that fails goes to 'unqualified' with explicit reasons (never
 * deleted — auditable). A contact that passes gets the verified scoring
 * (lead_score 75 / contact_confidence 80) so it clears John's bridge floor
 * (JOHN_MIN_LEAD_SCORE, default 70) on the strength of being a REAL,
 * owner-adjacent, Yana-verified person — not a fabricated org score.
 */

import { isValidEmail } from '../john/johnOutreachSafety.js'
import { isExcludedEmail } from './prospectExclusions.js'
import { ensureYanaLeadSchema } from './yanaLeadDiscovery.js'
import { OWNER_SEED_CONTACTS } from './yanaContactsImport.js'
import { isNonHumanEmail } from '../robert/robertContactDiscovery.js'
import { isListAddress, isUsableName, HARVEST_SOURCE } from '../robert/robertContactHarvest.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('yanaHarvestVerification')

export const VERIFIED_LEAD_SCORE = 75
export const VERIFIED_CONTACT_CONFIDENCE = 80
export const VERIFIED_URGENCY = 50

const OWNER_SELF = new Set(OWNER_SEED_CONTACTS.map((e) => e.toLowerCase()))

function parseJsonArray(v) {
  if (Array.isArray(v)) return v
  if (!v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/** Is this email already a GrantFlow user/profile contact? (never pitch clients) */
async function isExistingClient(db, email) {
  // "CANNOT TELL" IS NOT "NOT A CLIENT". Both probes used to swallow every
  // error and fall through to `false`, so a DB fault (not just the bare-test-DB
  // missing table the comments describe) turned an unanswerable question into a
  // confident "this address does not belong to a client" — and the caller then
  // let the lead proceed toward outreach, i.e. we pitch our own customer.
  // A probe that ERRORS is reported as unknown so the caller can refuse.
  let anyProbeAnswered = false
  let anyProbeFailed = null
  try {
    const u = await db.prepare('SELECT 1 FROM users WHERE lower(primary_email) = ? LIMIT 1').get(email)
    anyProbeAnswered = true
    if (u) return { isClient: true, known: true }
  } catch (err) { anyProbeFailed = err }
  try {
    const p = await db.prepare('SELECT 1 FROM profile_emails WHERE lower(email) = ? LIMIT 1').get(email)
    anyProbeAnswered = true
    if (p) return { isClient: true, known: true }
  } catch (err) { anyProbeFailed = anyProbeFailed ?? err }
  if (!anyProbeAnswered) {
    return { isClient: false, known: false, error: String(anyProbeFailed?.message || anyProbeFailed || 'unknown') }
  }
  return { isClient: false, known: true }
}

/**
 * Deterministic verdict for one harvested-candidate row.
 * Returns { verified: bool, reasons: string[] }.
 */
export async function verifyHarvestCandidate(db, row) {
  const reasons = []
  const email = String(row?.contact_email || '').trim().toLowerCase()
  const evidence = parseJsonArray(row?.public_evidence_json)
  const contact = evidence.find((e) => e?.type === 'contact') || null
  const name = contact?.name || row?.organization_name || null

  if (!email || !isValidEmail(email)) reasons.push('invalid_email')
  else {
    if (OWNER_SELF.has(email)) reasons.push('owner_self_address')
    if (isNonHumanEmail(email)) reasons.push('non_human_address')
    if (isListAddress(email)) reasons.push('list_address')
    if (isExcludedEmail(email)) reasons.push('excluded_domain')
    const clientCheck = await isExistingClient(db, email)
    if (clientCheck.isClient) reasons.push('existing_client')
    // Refuse rather than guess: an unanswerable client check must not verify a
    // candidate we might then pitch to our own customer.
    else if (!clientCheck.known) reasons.push('existing_client_check_unavailable')
  }
  if (!isUsableName(name, email)) reasons.push('missing_name')

  return { verified: reasons.length === 0, reasons }
}

/**
 * Verify a bounded batch of Robert-harvested candidates awaiting Yana's
 * verdict. Called from runYanaDiscovery each cycle (and callable on demand).
 * Only rows with source='robert_contact_harvest' AND status 'candidate' are
 * touched — Yana's other funnels and prior verdicts are never revisited here.
 */
export async function verifyRobertHarvestLeads(db, { limit = 200, runId = null } = {}) {
  await ensureYanaLeadSchema(db)
  const summary = { checked: 0, verified: 0, rejected: 0, reject_reasons: {} }
  const cap = Math.max(0, Math.floor(Number(limit) || 0))
  if (cap === 0) {
    summary.reason = 'limit_zero'
    return summary
  }

  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT * FROM yana_lead_candidates
         WHERE source = ? AND qualification_status = 'candidate'
         ORDER BY discovered_at ASC
         LIMIT ?`,
      )
      .all(HARVEST_SOURCE, cap)
  } catch (err) {
    log.warn(`verification scan failed: ${err?.message || err}`)
    return { ...summary, error: String(err?.message || err) }
  }

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  for (const row of rows || []) {
    summary.checked += 1
    const { verified, reasons } = await verifyHarvestCandidate(db, row)
    const priorReasons = parseJsonArray(row.qualification_reasons_json)
      .filter((r) => r !== 'pending_yana_verification')

    if (verified) {
      await db
        .prepare(
          `UPDATE yana_lead_candidates
              SET qualification_status = 'qualified',
                  lead_score = ?, contact_confidence = ?, urgency_score = ?, fit_score = ?,
                  qualification_reasons_json = ?,
                  run_id = COALESCE(?, run_id), updated_at = ${nowFn}
            WHERE id = ?`,
        )
        .run(
          VERIFIED_LEAD_SCORE,
          VERIFIED_CONTACT_CONFIDENCE,
          VERIFIED_URGENCY,
          VERIFIED_LEAD_SCORE,
          JSON.stringify([...priorReasons, 'yana_verified_owner_contact']),
          runId,
          String(row.id),
        )
      summary.verified += 1
    } else {
      await db
        .prepare(
          `UPDATE yana_lead_candidates
              SET qualification_status = 'unqualified',
                  qualification_reasons_json = ?,
                  run_id = COALESCE(?, run_id), updated_at = ${nowFn}
            WHERE id = ?`,
        )
        .run(
          JSON.stringify([...priorReasons, 'yana_verification_failed', ...reasons]),
          runId,
          String(row.id),
        )
      summary.rejected += 1
      for (const r of reasons) summary.reject_reasons[r] = (summary.reject_reasons[r] || 0) + 1
    }
  }
  return summary
}
