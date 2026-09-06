/**
 * pointerTruthPolicy.js — THE POINTER HALF OF THE FOUR GATES.
 *
 * `fundingTruthPolicy.js` owns the four gates for DIRECT funding: real,
 * relatable, meets a declared profile need, the profile qualifies. This module
 * owns the same four gates for POINTERS (directory / referral / school_portal /
 * past_award_intel). It lives beside its twin, inside Crawler OS, for the same
 * reason: discovery must be able to enforce the contract without crossing the
 * OS package boundary, and `config/fundingTruthPolicy.js` re-exports both so
 * there is ONE predicate authority repo-wide.
 *
 * WHY IT EXISTS (owner report 2026-09-06, Anastasia's crawl). Discover showed
 * "18 directories to search · 0 opportunities you can apply to" — every visible
 * row a pointer, none of them tied to her by anything: five 990 grantmakers in
 * Michigan / Missouri / Oklahoma, an Illinois university's transfer
 * scholarship, and an MTSU degree-program page, for a Cleveland, TN student.
 *
 * CAUSE, measured against prod (profile c4a92724…, 2026-09-06):
 *   `matchEngine.buildFourTruthProof` stamps `direct_funding:false` on every
 *   pointer, and the enforcement above it is guarded by
 *   `if (fourTruthProof.direct_funding …)`. The display authority
 *   (`config/matchSurfacing.qualifiesForDisplay`) then had a SECOND,
 *   independent pointer arm admitting any pointer that was merely not REJECT
 *   and scored at/above REVIEW — and admitting an UNSCORED pointer
 *   unconditionally. A pointer therefore needed no positive evidence of
 *   anything. Kresge (Troy MI) and Community Foundation for Southeast Michigan
 *   (Detroit) surfaced with `matchedSignals: ["category","needs"]` — no
 *   geographic leg at all. "Scholarships & Grants - Bradley University"
 *   (bradley.edu, Peoria IL) surfaced with `dataPointEvidence.total_credit: 0`
 *   and no matched needs or signals whatsoever: it was re-offered purely
 *   because it was discovered during a crawl run for her
 *   (`gate: "recorded_discovery_provenance"`).
 *
 * THE RULE. A pointer is a research lead, not an award, so its proof is not the
 * direct-funding proof — it is the same four gates read in their pointer sense:
 *
 *   real       — a live resource with somewhere to go: a URL, and no rejected
 *                or expired reality verdict.
 *   relatable  — the engine tied it to THIS profile GEOGRAPHICALLY (state,
 *                city, county, or an honestly national/federal locator). A row
 *                that matched only on "category" is not relatable; this single
 *                leg is what separates a Cleveland-TN locator from a Detroit
 *                foundation.
 *   meets need — the engine recorded at least one matched need. Those needs are
 *                the profile∩opportunity intersection the scorer already
 *                computed; nothing is re-mined from prose here (the
 *                prose-denial class).
 *   qualifies  — the pair carries a positive verdict (not REJECT, eligibility
 *                not an affirmative NO) AND the engine actually used the
 *                profile's own data points on it. A provenance stamp is not a
 *                match.
 *
 * READ, NEVER RE-DERIVED. Every leg is read from evidence the canonical engine
 * ALREADY persisted per pair (`match_explain_json`), in all three shapes the
 * store holds: the canonical shape (`matchedNeeds`/`matchedSignals`), the
 * crawler-os shape (`matched_needs`/`matched_profile_facts`/`matched_location`),
 * and the linkage-lane shape (`gate:"recorded_discovery_provenance"`, which
 * carries no profile evidence and therefore fails). So the contract binds the
 * EXISTING store on the next page load — it does not wait for a re-crawl.
 *
 * SILENCE FAILS, AND IS REPORTED — the standing rule from
 * `services/pipelinePrecision.js`. A pointer nobody scored against this profile
 * is unknown, not relevant; `pointerTruthVerdict` names the failed legs so read
 * paths can count them in `diagnostics.dropped_reasons` instead of dropping
 * them silently.
 */

/**
 * Reality verdicts that mean "this row is not a live resource".
 *
 * DELIBERATELY NOT link_status. A broken `link_status` is already handled one
 * layer up by the canonical enricher, which SHOWS such a pointer carrying
 * `trust_downgrade` rather than hiding it (see realCrawlerDisplayAuthority's
 * "keeps lifecycle/trust quarantine for direct rows while labeling pointers").
 * Folding that verdict in here would silently overturn a settled contract that
 * has nothing to do with the four gates.
 */
const DEAD_REALITY = new Set(['rejected', 'expired'])
/** Eligibility verdicts that are an affirmative NO (never "unknown"). */
const NEGATIVE_ELIGIBILITY = new Set(['no', 'ineligible', 'not_eligible', 'false'])

function parseObject(value) {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function explainOf(row) {
  if (!row || typeof row !== 'object') return {}
  return parseObject(row.match_explain) ?? parseObject(row.match_explain_json) ?? {}
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** The needs the engine recorded for THIS pair, in either persisted shape. */
export function pointerMatchedNeeds(row) {
  const explain = explainOf(row)
  return [
    ...asArray(explain.matchedNeeds),
    ...asArray(explain.matched_needs),
    ...asArray(row?.matchedNeeds),
    ...asArray(row?.matched_needs),
  ].filter((need) => typeof need === 'string' && need.trim() !== '')
}

/**
 * Did the engine tie this pointer to the profile GEOGRAPHICALLY?
 *
 * Deliberately reads the per-pair MATCH evidence, never the row's own `state`
 * column: that column is crawl provenance and is measurably wrong (the Bradley
 * University row — bradley.edu, Peoria IL — carries `state:'TN'`; the MTSU
 * "Forensic Science, B.S." row carries `state:'GA'`). Demoting the state column
 * to non-evidence is the same call the geography gate already made (#1380).
 */
export function pointerGeoEvidence(row) {
  const explain = explainOf(row)
  const signals = [...asArray(explain.matchedSignals), ...asArray(explain.matched_signals)].map(lower)
  if (signals.some((signal) => signal.startsWith('geo:'))) return true
  const facts = [...asArray(explain.matched_profile_facts), ...asArray(explain.matchedProfileFacts)].map(lower)
  if (facts.some((fact) => fact.includes('geo:'))) return true
  const location = lower(explain.matched_location ?? explain.matchedLocation)
  return location !== '' && location !== 'none' && location !== 'no match' && location !== 'null'
}

/** Did the engine actually use the profile's own data points on this pair? */
export function pointerProfileEvidence(row) {
  const explain = explainOf(row)
  if (explain.matched_profile_type === true) return true
  if (asArray(explain.matchedSignals).length > 0) return true
  if (asArray(explain.matched_profile_facts).length > 0) return true
  const matchedCount = Number(
    explain.dataPointEvidence?.matched_count ?? explain.dataPointEvidence?.matchedCount,
  )
  if (Number.isFinite(matchedCount) && matchedCount > 0) return true
  return pointerMatchedNeeds(row).length > 0
}

/**
 * The four gates in their pointer sense. Returns the verdict AND the failed leg
 * names, so no drop is ever silent.
 *
 * @returns {{ pass: boolean, failed: string[], legs: Record<string, boolean> }}
 */
export function pointerTruthVerdict(row) {
  const decision = lower(row?.match_decision ?? row?.decision)
  const explain = explainOf(row)
  const eligibility = lower(explain.eligibility_fit ?? row?.eligible ?? row?.eligibility_fit)
  const url = row?.url ?? row?.actionable_url ?? row?.application_url ?? row?.apply_url ??
    row?.source_url ?? row?.evidence_url ?? row?.info_url ?? null

  const legs = {
    real: Boolean(url) && !DEAD_REALITY.has(lower(row?.reality_status)),
    relatable: pointerGeoEvidence(row),
    meets_profile_need: pointerMatchedNeeds(row).length > 0,
    profile_qualifies: decision !== 'reject' &&
      !NEGATIVE_ELIGIBILITY.has(eligibility) &&
      pointerProfileEvidence(row),
  }
  const failed = Object.entries(legs).filter(([, passed]) => !passed).map(([name]) => name)
  return { pass: failed.length === 0, failed, legs }
}

/** Boolean twin of `pointerTruthVerdict`, for read paths that only gate. */
export function hasPositivePointerTruth(row) {
  return pointerTruthVerdict(row).pass
}

export default {
  pointerMatchedNeeds,
  pointerGeoEvidence,
  pointerProfileEvidence,
  pointerTruthVerdict,
  hasPositivePointerTruth,
}
