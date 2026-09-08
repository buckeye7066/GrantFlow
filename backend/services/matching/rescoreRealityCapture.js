/**
 * rescoreRealityCapture.js — capture-time proof for a re-scored catalog row.
 *
 * WHY THIS EXISTS (measured 2026-09-08). The catalog re-score sweep
 * (`catalogRescoreSweep.js`) wrote ACCEPT rows carrying no `four_truth_proof`,
 * and `enforcePersistedMatchDecisionIntegrity` deleted every one of them later
 * in the SAME boot ladder — its counter is literally
 * `removed_unproven_direct_accepts`. Proven by running all 70 enforcers in
 * sequence over a live 32-row lane: the integrity net took it 32 -> 0 and
 * nothing else touched the rows. That is why `catalog-rescore-link` sits at 0
 * fleet-wide forever while its cursor advances through cycles 2-4.
 *
 * WHY NO SHORTCUT IS HONEST. `hasPositiveFourTruthProof` requires the REAL leg
 * to carry `reality_status ∈ {VERIFIED, ROLLING}`, an `evidence_url`, a
 * CONTENT HASH, and a parseable capture timestamp. Measured over all 20,407
 * active non-pointer catalog rows: reality_status ok 18,244, evidence_url
 * 20,405, last_verified_at 19,512, and **content hash 0** — not one row can
 * support an honest REAL leg. `refreshFourTruthProof` cannot help either: it
 * returns null when there is no PREVIOUS proof and deliberately never
 * manufactures reality evidence.
 *
 * And the catalog lacks the hash BY DESIGN, correctly:
 * `crawlerOsPersistenceCore.osOppToLiveRow` carries `evidence_url` and
 * `reality_status` but refuses to stamp `last_verified_at`, because fetching
 * the LISTING page is not verification of THIS opportunity's application
 * target — stamping it lied in the UI and made `linkVerificationService` skip
 * the row for ~30 days so its real target was never checked.
 *
 * THEREFORE: publishing "this is real funding you can apply to" requires that
 * something actually looked at the page. This module does exactly that, for
 * only the rows a re-score would otherwise ACCEPT, and returns evidence — never
 * a verdict. It writes no verdict, admits nothing, and hides nothing.
 *
 * DO NOT "fix" the deletion by exempting the lane from the integrity net. The
 * integrity net is right; the defect was that a writer publishing direct
 * funding was never required to carry capture-time proof (the same class as the
 * `canonical-rescore-link` proof-stripping residue, #1601).
 *
 * Burn semantics are `enforceAmountEnrichment`'s, for the same reasons:
 *   - a REAL answer (page read, or a stable 404/410) is a fact about the ROW;
 *   - 401/403/429 is a WAF/bot-block refusing OUR egress — a fact about the
 *     deploy environment, never about the row, so it is `environment` and must
 *     never spend the row's retry budget (the mass-burn class);
 *   - 5xx/timeout/statusless is `transient` and burns nothing.
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('matching:rescoreRealityCapture')

/** Reality verdicts that can support a positive REAL leg (mirrors POSITIVE_REALITY). */
const POSITIVE_REALITY = new Set(['VERIFIED', 'ROLLING'])

/**
 * The page whose reality we are proving is the one an applicant would open.
 * `apply_url` IS an apply target (#1601); a bare `source_url` is a listing page
 * and proves nothing about this award, so it is the last resort and is recorded
 * as such by the caller.
 */
export function captureTargetUrl(row) {
  const candidates = [row?.apply_url, row?.application_url, row?.url, row?.evidence_url, row?.source_url]
  for (const c of candidates) {
    const v = typeof c === 'string' ? c.trim() : ''
    if (v) return v
  }
  return null
}

function isTransientStatus(status) {
  // TRAP (documented, and this function shipped with it): `Number(null)` is 0
  // and `Number.isFinite(0)` is TRUE, so a bare finite check reads a STATUSLESS
  // failure — we never reached the host at all — as a stable 4xx and burns the
  // row. Absence must be tested before coercion.
  if (status === null || status === undefined || status === '') return true
  const code = Number(status)
  if (!Number.isFinite(code)) return true // unparseable = we never reached it
  return code >= 500 || code === 408
}

/**
 * Fetch a row's apply target and return capture-time evidence for the REAL leg.
 *
 * Never throws: a capture failure must degrade the sweep to "cannot publish
 * this row yet", never fail the run.
 *
 * @returns {Promise<{attempted:boolean, captured:boolean, transient:boolean,
 *   environment:boolean, status:number|null, contentHash:string|null,
 *   fetchedAt:string|null, evidenceUrl:string|null, reason:string|null}>}
 */
export async function captureRealityEvidence(row, { fetcher } = {}) {
  const base = {
    attempted: false, captured: false, transient: false, environment: false,
    status: null, contentHash: null, fetchedAt: null, evidenceUrl: null, reason: null,
  }

  const url = captureTargetUrl(row)
  if (!url) return { ...base, reason: 'no_url' }

  // The REAL leg needs BOTH the reality gate's positive verdict AND our fresh
  // capture. A 200 does not overturn a REJECTED/EXPIRED verdict, and it is not
  // ours to invent one for a row the gate never ruled on — `hasPositiveFourTruthProof`
  // reads `reality_status` off the leg, so capturing such a row would spend a
  // fetch on something that could never publish.
  const reality = String(row?.reality_status ?? '').toUpperCase()
  if (!POSITIVE_REALITY.has(reality)) {
    return { ...base, evidenceUrl: url, reason: reality ? `reality_${reality.toLowerCase()}` : 'reality_unrated' }
  }

  let client = fetcher
  if (!client) {
    try {
      const { makeProductionFetcher } = await import('../crawlerOsService.js')
      client = makeProductionFetcher()
    } catch (err) {
      // No fetcher is an environment fact, not a row fact.
      return { ...base, attempted: false, transient: true, environment: true, evidenceUrl: url, reason: 'no_fetcher' }
    }
  }

  let res
  try {
    res = await client.fetch(url)
  } catch (err) {
    log.warn('capture threw (non-fatal)', { url, error: String(err?.message || err) })
    return { ...base, attempted: true, transient: true, evidenceUrl: url, reason: 'fetch_threw' }
  }

  const status = res?.status ?? null
  const code = Number(status)
  // 401/403/429 refuses OUR caller, not the URL — never a fact about the row.
  const environment = code === 401 || code === 403 || code === 429
  if (environment) {
    return { ...base, attempted: true, transient: true, environment: true, status, evidenceUrl: url, reason: 'blocked_by_host' }
  }

  if (!res?.ok || !res?.contentHash) {
    const transient = isTransientStatus(status)
    return {
      ...base,
      attempted: true,
      transient,
      status,
      evidenceUrl: url,
      // A stable 4xx IS an answer about the row: the page is gone.
      reason: transient ? 'fetch_failed' : 'page_gone',
    }
  }

  return {
    attempted: true,
    captured: true,
    transient: false,
    environment: false,
    status,
    contentHash: res.contentHash,
    fetchedAt: res.fetchedAt ?? new Date().toISOString(),
    // The FINAL url is what we actually read — a redirect means the evidence
    // belongs to where we landed, not where we aimed.
    evidenceUrl: res.finalUrl || url,
    reason: null,
  }
}

/**
 * Build the REAL leg of a four-truth proof from a fresh capture.
 *
 * Returns null when nothing was captured — the caller must then NOT publish the
 * row as direct funding. Manufacturing a passing leg here would be exactly the
 * fabrication `refreshFourTruthProof` refuses to do.
 */
export function realLegFromCapture(row, capture) {
  if (!capture?.captured || !capture.contentHash) return null
  return {
    passed: true,
    gate: 'matching.rescoreRealityCapture.captureRealityEvidence',
    reality_status: row?.reality_status ?? null,
    evidence_url: capture.evidenceUrl,
    evidence_captured_at: capture.fetchedAt,
    content_hash_present: true,
  }
}

export default { captureRealityEvidence, realLegFromCapture, captureTargetUrl }
