/**
 * amyReport.js
 *
 * Turns the raw Crawler-OS discovery result for one synthetic profile into a
 * set of structured "findings" describing where the crawler succeeded or fell
 * short, then assembles a single Anya-consumable handoff report.
 *
 * The handoff mirrors the object shape `admin.anya.runAutonomous` returns (the
 * report that lands in audit-reports/anya-audit-*.json): a flat `findings[]`
 * with { file, line, type, severity, message, excerpt, fixable, search_kind,
 * evidence } so Anya can act on real repo file targets, plus an `amy_summary`
 * block with per-category / per-status / source-health aggregates.
 */

import { DEFAULT_MIN_SCORE, ACCEPT_SCORE, REVIEW_SCORE } from '../../config/matchThresholds.js'
import { isStudentAidOpportunity } from '../matchEngine.js'
import { classifyThesisArchetype } from '../../crawler-os/archetypes.js'
import { FINDING_TYPES, SEVERITY, SEARCH_KIND, CODE_TARGETS, ORIGIN_AGENT } from './amyConstants.js'
import { isGenericTitle, isGenericOnly } from '../../config/genericTitleVocabulary.js'
import { AMOUNT_STATUS_NONE_PUBLISHED } from '../awardAmountExtractor.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'
import { titleStatesTerm } from '../../config/profileDerivedFacts.js'
import { blindSpotForGate } from './pipelineGuardEscapeAudit.js'

/** Needs that mean a profile legitimately WANTS student aid (engine's carve-out). */
const STUDENT_AID_NEEDS = ['student_aid', 'cost_of_attendance', 'scholarship']

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function decisionUpper(d) {
  return String(d ?? '').trim().toUpperCase()
}

// The engine's canonical decision is authoritative. A high raw score can still
// be REVIEW after eligibility, generic-title, locator, or safety caps. Amy used
// to count such rows as ACCEPT via an OR-score fallback, manufacturing false
// ineligible/false-positive findings after the engine had already contained the
// row. Only fall back to score bands for legacy rows that carry no recognized
// decision at all.
const CANONICAL_RECOMMENDATION_DECISIONS = new Set(['ACCEPT', 'REVIEW', 'REJECT'])
function canonicalRecommendationDecision(recommendation) {
  const explicit = decisionUpper(
    recommendation?.decision ?? recommendation?.match_decision,
  )
  if (CANONICAL_RECOMMENDATION_DECISIONS.has(explicit)) return explicit

  // Fail closed for legacy/incomplete producer rows. A score is fit evidence,
  // not permission to bypass eligibility, generic-title, locator, source, or
  // actionability caps. Missing canonical truth may remain human-reviewable,
  // but Amy must never promote it to ACCEPT on score alone.
  return num(recommendation?.match_score) >= REVIEW_SCORE ? 'REVIEW' : 'REJECT'
}

/** Build one Anya-shaped finding from a type + specifics. */
function makeFinding(type, { message, excerpt, evidence, severity }) {
  const target = CODE_TARGETS[type] || { file: 'backend/services/crawlerOsService.js', line: 1, severity: SEVERITY.MEDIUM, hint: '' }
  return {
    file: target.file,
    line: target.line,
    type,
    severity: severity || target.severity || SEVERITY.MEDIUM,
    message: message || target.hint,
    excerpt: excerpt || '',
    fixable: false, // Amy is diagnostic; Anya decides + applies the code fix.
    search_kind: SEARCH_KIND,
    evidence: evidence || {},
  }
}

function looksLikeFetchFailure(source) {
  const outcome = String(source?.outcome ?? '').toUpperCase()
  if (['ERROR', 'FETCH_ERROR', 'FAILED', 'FAIL'].includes(outcome)) return true
  const reason = String(source?.reason ?? '').toLowerCase()
  return /error|timeout|timed out|failed|forbidden|refused|unreachable|429|5\d\d|dns/.test(reason)
}

function looksLikeUrlIssue(source) {
  const reason = String(source?.reason ?? '').toLowerCase()
  return /\burl\b|\blink\b|invalid url|missing url|bad url|broken/.test(reason)
}

function looksLikeGeoIssue(text) {
  return /\bgeo\b|geograph|location|state|radius|out[- ]of[- ]state/.test(String(text ?? '').toLowerCase())
}

// Generic/directory-style titles that should NOT be high-confidence ACCEPTs for
// a specific synthetic profile — an ACCEPT here is a likely false positive.
//
// isGenericTitle comes from backend/config/genericTitleVocabulary.js, the ONE
// registry the engine's ACCEPT cap reads too. This detector used to carry its
// own GENERIC_TITLE_RX which shared only 4 of ~12 terms with the gate's list,
// so Amy flagged phrasings no gate could act on. Totality test:
// backend/tests/genericTitleVocabulary.test.js.

// A DIRECTORY locator is a declared pointer, not a claimed award. It is titled
// generically BY DESIGN ("… Resource Directory") and reaches the recommendation
// list through isRecommendable()'s locator rule at REVIEW — computeMatchDecision
// no longer lets one claim ACCEPT. So a locator is not evidence of a relevance
// defect, and counting one as a false positive measured the naming convention
// rather than the matcher. A generic-titled NON-locator that clears ACCEPT is
// still a real false positive and still counts below.
function isLocatorKind(kind) {
  return String(kind ?? '').toUpperCase() === 'DIRECTORY'
}

// amount_status values that mean "the funder itself states no per-award figure"
// — an honest answer, not a recall failure.
//
// 'not_listed' is deliberately NOT here, and that has always been right: it is
// the extractor's DEFAULT, so it means "nobody found a figure" and cannot tell
// a real extraction miss from a funder that publishes none. Silence is not a
// denial. Keeping it in the denominator is what makes this finding able to fire.
//
// 'none_published' IS here: it is written ONLY by enforceAmountEnrichment after
// the funder's own page or API was actually READ and stated no per-award figure
// (awardAmountExtractor.AMOUNT_STATUS_NONE_PUBLISHED). That is evidence about
// the world, not an absence in our DB — the one thing that can honestly retire
// a row from this finding.
//
// Why it matters here: on 2026-07-16 this finding fired for 28 of 50 synthetic
// profiles, every one of them on rows whose funders publish nothing (benefit
// programs, food-bank locators, SSI). Amy could not know that, because the read
// that proved it threw its own answer away. So the cohort could never come back
// clean, and the owner's standing "50/50 clean → notify me once" goal was
// unreachable BY CONSTRUCTION. Do not add 'not_listed' here to make the number
// look better — that would delete the finding rather than answer it.
const AMOUNT_UNKNOWABLE_STATUSES = new Set(['varies', 'contact_required', AMOUNT_STATUS_NONE_PUBLISHED])

function normLower(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Acronym of significant words ("Cleveland State Community College" -> "cscc")
// so a school referenced only by acronym still counts as recalled.
const RECALL_STOP = new Set(['of', 'the', 'and', 'at', 'for', 'a', 'an'])
function schoolAcronym(name) {
  const w = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  return w.length >= 2 ? w.map((x) => x[0]).join('') : ''
}

const GENERIC_INSTITUTION_TAILS = new Set(['university', 'college', 'school', 'institute', 'academy'])

// Branch campuses are often published as "MSU Billings" or "IU Bloomington"
// rather than the full legal institution name. Build only the high-precision
// acronym+campus alias; never fall back to loose token overlap.
function schoolCampusAlias(name) {
  const words = normLower(name).split(' ').filter((x) => x && !RECALL_STOP.has(x))
  if (words.length < 3 || words[0] === 'university') return ''
  const campus = words.at(-1)
  if (!campus || GENERIC_INSTITUTION_TAILS.has(campus)) return ''
  const baseAcronym = words.slice(0, -1).map((x) => x[0]).join('')
  return baseAcronym.length >= 2 ? `${baseAcronym} ${campus}` : ''
}

// A very small, evidence-backed publication-name registry. Institutions often
// publish awards under a protected short name that is neither the legal name nor
// a safe acronym. Keep this explicit rather than accepting loose token overlap.
const SCHOOL_PUBLICATION_ALIASES = new Map([
  ['the ohio state university', ['ohio state']],
])
function schoolPublicationAliases(name) {
  return SCHOOL_PUBLICATION_ALIASES.get(normLower(name)) || []
}

/** True if any normalized title/sponsor references the school (full name, acronym, campus alias, or protected publication name). */
function titlesReference(normalizedTitles, school) {
  const n = normLower(school)
  if (!n || n.length < 3) return false
  const acr = schoolAcronym(school)
  const campusAlias = schoolCampusAlias(school)
  const publicationAliases = schoolPublicationAliases(school)
  const acrRx = acr && acr.length >= 2 ? new RegExp(`\\b${acr}\\b`) : null
  return normalizedTitles.some((t) =>
    t.includes(n) ||
    publicationAliases.some((alias) => t.includes(alias)) ||
    (campusAlias && t.includes(campusAlias)) ||
    (acrRx && acrRx.test(t)),
  )
}

/**
 * Evaluate one discovery result against a scenario. Pure function; no I/O.
 *
 * @param {object} scenario  - from generateScenarios()
 * @param {string} profileId
 * @param {object} result    - { run, persisted, thesis } from runProfileDiscoveryLive
 * @param {object} [opts]    - { error } when discovery threw
 * @returns {{ scenario_id, category, profile_id, status, stored, accepted, review, findings }}
 */
export function evaluateDiscovery(scenario, profileId, result, opts = {}) {
  const findings = []
  const baseEvidence = {
    scenario_id: scenario?.scenario_id,
    category: scenario?.category,
    label: scenario?.label,
    profile_id: profileId,
    // The Amy run is the cohort boundary. The crawler run below is a separate
    // execution id and may differ per profile, so retaining only `run_id`
    // cannot prove that fifty evaluations belong to the same cohort.
    cohort_run_id: opts.runId || null,
    cohort_member_id: scenario?.scenario_id || null,
    run_id: result?.run?.run_id || opts.runId || null,
    // Archetype key (crawler-os/archetypes.js) — the aggregation unit the
    // archetype-learning flywheel generalizes this profile's lessons under.
    // Classified from the REAL discovery thesis so producer and consumer
    // (live-crawl steering) can never drift.
    archetype: result?.thesis ? classifyThesisArchetype(result.thesis) : null,
  }

  // Hard error path (discovery threw).
  if (opts.error) {
    findings.push(
      makeFinding(FINDING_TYPES.CRAWLER_EXCEPTION, {
        message: `Discovery threw for ${scenario?.label}: ${opts.error}`,
        excerpt: String(opts.error).slice(0, 220),
        evidence: { ...baseEvidence, error: String(opts.error) },
      }),
    )
    return { ...baseEvidence, status: 'error', stored: 0, accepted: 0, review: 0, findings }
  }

  const run = result?.run || {}

  // Lifecycle skip.
  if (run.skipped) {
    findings.push(
      makeFinding(FINDING_TYPES.DISCOVERY_SKIPPED, {
        message: `Discovery skipped for ${scenario?.label} (reason: ${run.reason || 'unknown'}).`,
        excerpt: `reason=${run.reason || 'unknown'}`,
        evidence: { ...baseEvidence, reason: run.reason },
      }),
    )
    return { ...baseEvidence, status: 'skipped', stored: 0, accepted: 0, review: 0, findings }
  }

  const sources = Array.isArray(run.sources) ? run.sources : []
  const stored = num(run.stored ?? result?.persisted?.opportunities)
  const recommendations = Array.isArray(run.recommendations) ? run.recommendations : []
  const accepted = recommendations.filter(
    (r) => canonicalRecommendationDecision(r) === 'ACCEPT',
  )
  const review = recommendations.filter(
    (r) => canonicalRecommendationDecision(r) === 'REVIEW',
  )
  const topScore = recommendations.reduce((m, r) => Math.max(m, num(r.match_score)), 0)

  // ── LOCATOR-ONLY SPLIT (2026-08-01) ───────────────────────────────────────
  // `isRecommendable()` (crawler-os/matchEngine.js) admits exactly two things:
  // an ACCEPT of any kind, and a DIRECTORY locator at REVIEW. So a REVIEW row
  // in this list is, BY CONSTRUCTION, a DIRECTORY locator — and the canonical
  // locator rule says a locator can NEVER claim ACCEPT.
  //
  // That made the weak_match finding structurally unfalsifiable for any profile
  // whose reachable universe is pointers: `accepted.length === 0 &&
  // review.length > 0` reported "top score 54 (review-band only)", inviting the
  // reader to believe a real award nearly qualified, when 54 was a LOCATOR's
  // score that the product forbids from ever accepting. Amy then minted a
  // `scoring_weights` approval item — a lever that provably cannot move the
  // final score (weights act only inside the topical-evidence blend; see
  // matchThresholds.TOPICAL_EVIDENCE_STRONG_BAR) — so the item could not be
  // closed by the only mechanism offered for it. Prod 2026-07-30: four such
  // items (tribal_org, community_development_corp, housing_authority,
  // workforce_org), three of them with top_score exactly 10.
  //
  // This is the SAME class as the already-fixed false_positive/locator artifact
  // ("counting locators measured the naming convention, not the matcher"). The
  // fix is NOT to drop locators from the list (that is the forbidden other end
  // of the defect) and NOT to let them ACCEPT — it is to say which fact we are
  // reporting: a DIRECT-award recall gap, or a locator-only universe.
  // WHICH KINDS COUNT AS A POINTER comes from the canonical registry
  // (`config/opportunityKindClasses.js`), never from a kind typed here. Prod
  // 2026-08-01 carries FOUR pointer kinds — `directory` 4271, `DIRECTORY` 224,
  // `referral` 119, `school_portal` 102 — and school_portal rows really do
  // reach match rows. A hand-typed `=== 'DIRECTORY'` here is the exact subset
  // bug #1088 fixed one level over in `pipeline.amountCoverage`.
  //
  // POINTER_KINDS, not NO_PER_AWARD_FIGURE_KINDS: a BENEFIT program publishes
  // no fixed figure but IS the thing you apply to, so it is a real direct
  // award for this question (511 benefit match rows in prod would otherwise
  // be misreported as pointers).
  //
  // `isLocatorKind` is deliberately left alone and still guards the
  // false_positive detector: CLAUDE.md pins that contract to declared
  // DIRECTORY locators, and widening it there would change a different,
  // already-calibrated finding.
  const locatorRecs = recommendations.filter((r) => isPointerKind(r.kind))
  const directRecs = recommendations.filter((r) => !isPointerKind(r.kind))
  const topDirectScore = directRecs.reduce((m, r) => Math.max(m, num(r.match_score)), 0)
  const topLocatorScore = locatorRecs.reduce((m, r) => Math.max(m, num(r.match_score)), 0)
  // Locator-only: something was recommended, and every one of them is a pointer.
  const locatorOnly = recommendations.length > 0 && directRecs.length === 0

  // Retain the scored candidates so the tuner can sweep the score floor across
  // the whole cohort WITHOUT re-crawling (the floor is applied after scoring).
  //
  // `topical` retains the LEGACY weighted-evidence subscale
  // (scoreBreakdown.topical_evidence). Need-anchored split (2026-07-06): the
  // final match score is need-coverage × eligibility/geo gates and no longer
  // moves with W_* weight changes — weights act only inside this blend — so
  // Amy's weight-tuning KEEP/REVERT validation measures quality on `topical`.
  // Falls back to the final score for older results that lack the breakdown.
  const topicalEvidenceOf = (r) => {
    const v =
      r?.topical_evidence ??
      r?.scoreBreakdown?.topical_evidence ??
      r?.match_explain?.scoreBreakdown?.topical_evidence ??
      r?.match_explain?.score_breakdown?.topical_evidence
    return Number.isFinite(Number(v)) ? Number(v) : num(r?.match_score)
  }
  // The SAME text the engine's generic-only ACCEPT cap evaluates.
  // computeMatchDecision builds `oppText = title + description` and tests
  // isGenericOnly(oppText) — so a generically-TITLED row whose DESCRIPTION
  // carries a concrete anchor ("El Paso County General Assistance Program"
  // whose description says "rent") is DELIBERATELY rescued by the cap and its
  // ACCEPT stands. This detector used to test the TITLE alone, so it flagged
  // exactly the rows the cap had deliberately rescued — an unfixable
  // "false positive" no vocabulary approval could ever close (the
  // false_positive:veteran / El Paso queue item, 2026-08-02). Mirror the
  // cap's text construction EXACTLY (matchEngine.js `oppText`). Rec rows
  // from producers that predate the description field degrade to title-only,
  // which is the old behavior, never a silent un-flag.
  const capTextOf = (r) => `${r.title || ''} ${r.description || ''}`.toLowerCase()
  const candidates = recommendations.map((r) => ({
    score: num(r.match_score),
    topical: topicalEvidenceOf(r),
    decision: canonicalRecommendationDecision(r),
    title: r.title ?? null,
    locator: isLocatorKind(r.kind),
    generic: isGenericTitle(r.title),
    // generic AND no concrete anchor ACROSS TITLE+DESCRIPTION — the cap's own
    // predicate on the cap's own text. "Cancer Resource Directory" is generic
    // by title but is genuinely a cancer row, so it is not genericOnly; a
    // generic title with "rent" in the description is not genericOnly either.
    genericOnly: isGenericOnly(capTextOf(r)),
  }))

  // False positives: a generic-ONLY listing (no concrete anchor) that the engine
  // still ACCEPTED as a strong match for a SPECIFIC profile.
  //
  // Three deliberate narrowings:
  //  - DIRECTORY locators are excluded: they are pointers admitted at REVIEW by
  //    the locator rule, so a high score on one is topical fit, not an over-claim.
  //  - the DECISION is what counts, not the raw score. matchEngine's generic-only
  //    cap holds these at REVIEW while their topical score legitimately stays at
  //    or above ACCEPT_SCORE — firing on `score >= ACCEPT_SCORE` would report a
  //    false positive the engine had already prevented.
  //  - the TEXT is the cap's text (title + description via capTextOf above), so
  //    a row the cap deliberately rescued via a concrete description anchor is
  //    not re-flagged against a narrower reading of the same rule.
  // Post-cap this should be structurally impossible; if it fires, the cap leaked
  // — genuinely generic across title AND description, yet certified ACCEPT.
  const falsePositives = candidates.filter(
    (c) => c.genericOnly && !c.locator && c.decision === 'ACCEPT',
  )
  if (falsePositives.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.FALSE_POSITIVE, {
        message: `${scenario.label}: ${falsePositives.length} generic non-directory listing(s) were ACCEPTED as strong matches despite the generic-only cap (likely false positive — the vocabulary may not yet cover this phrasing).`,
        excerpt: falsePositives.map((c) => `${c.score}:${c.title}`).slice(0, 4).join('; '),
        evidence: { ...baseEvidence, false_positive_titles: falsePositives.map((c) => c.title).slice(0, 6) },
      }),
    )
  }

  // Profile-field mapping: a signal we set didn't reach the thesis.
  const thesis = result?.thesis || {}
  const thesisNeeds = Array.isArray(thesis.needs) ? thesis.needs : []
  const thesisTypes = Array.isArray(thesis.applicant_types) ? thesis.applicant_types : []
  const thesisState = thesis?.location?.state || null

  // ── ELIGIBILITY MISMATCH (crawler-intelligence signal) ─────────────────────
  // The goal is smarter crawlers: an opportunity the profile CANNOT apply for
  // must never ACCEPT. The canonical example (2026-07-01) is enrolled-student aid
  // (TN HOPE / FAFSA / Pell / TSAA) accepted for a NON-student individual/family.
  // Mirrors the engine's own cap condition (!is_student && !wantsStudentAid), so a
  // real student or an aid-seeking adult never trips it. Reuses the engine's own
  // isStudentAidOpportunity predicate (no drift). Routes Anya at the eligibility
  // GATE so the fix is at SCORING time, not just the surface-table net.
  const wantsStudentAid = thesisNeeds.some((n) => STUDENT_AID_NEEDS.includes(String(n)))
  const ineligibleAccepts = (!thesis.is_student && !wantsStudentAid)
    ? accepted.filter((r) => isStudentAidOpportunity({ title: r.title, description: r.sponsor }, null))
    : []
  if (ineligibleAccepts.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.INELIGIBLE_MATCH, {
        message: `${scenario.label}: ${ineligibleAccepts.length} enrolled-student-aid opportunit(ies) were ACCEPTED for a NON-student profile — the eligibility gate is under-enforcing (these must REJECT/cap at scoring time).`,
        excerpt: ineligibleAccepts.map((r) => `${r.match_score}:${r.title}`).slice(0, 4).join('; '),
        evidence: { ...baseEvidence, ineligible_titles: ineligibleAccepts.map((r) => r.title).slice(0, 6), is_student: Boolean(thesis.is_student), thesis_needs: thesisNeeds },
      }),
    )
  }

  // ── BOUNDED OPPORTUNITY ORACLE ──────────────────────────────────────────
  // An engine ACCEPT is a decision, not independent proof that the applicant
  // qualifies. Amy's synthetic fixtures do, however, give us enough truth to
  // run a small, defensible opportunity-level oracle over every ACCEPT:
  //   * the row has a stable opportunity id, title, and declared kind;
  //   * a pointer/directory never masquerades as a direct award;
  //   * known student-aid programs never pass for a known non-student who did
  //     not request student aid.
  // Anything outside that evidence is UNKNOWN, never silently clean. This is
  // intentionally narrower than the canonical matcher and explicitly does not
  // claim award eligibility, qualification, or likely success.
  const oracleUnknowns = []
  const oracleIneligible = []
  const oracleChecks = accepted.map((opportunity, index) => {
    const title = String(opportunity?.title || '').trim()
    const kind = String(opportunity?.kind || '').trim()
    const opportunityId = String(opportunity?.opportunity_id ?? opportunity?.id ?? '').trim()
    const check = {
      index,
      opportunity_id: opportunityId || null,
      title: title || null,
      kind: kind || null,
      decision: canonicalRecommendationDecision(opportunity),
      outcome: 'checked_no_known_conflict',
      reason: null,
    }

    if (!title) {
      check.outcome = 'unknown'
      check.reason = 'missing_opportunity_identity'
      oracleUnknowns.push(check)
      return check
    }
    if (!kind) {
      check.outcome = 'unknown'
      check.reason = 'missing_opportunity_kind'
      oracleUnknowns.push(check)
      return check
    }
    if (!opportunityId) {
      check.outcome = 'unknown'
      check.reason = 'missing_opportunity_id'
      oracleUnknowns.push(check)
      return check
    }
    if (isPointerKind(kind)) {
      check.outcome = 'known_conflict'
      check.reason = 'pointer_claimed_accept'
      oracleIneligible.push(check)
      return check
    }

    const studentAid = isStudentAidOpportunity(
      {
        title,
        description: `${opportunity?.description || ''} ${opportunity?.sponsor || ''}`.trim(),
      },
      null,
    )
    if (studentAid && typeof thesis.is_student !== 'boolean' && !wantsStudentAid) {
      check.outcome = 'unknown'
      check.reason = 'student_status_unknown'
      oracleUnknowns.push(check)
      return check
    }
    if (studentAid && !thesis.is_student && !wantsStudentAid) {
      check.outcome = 'known_conflict'
      check.reason = 'student_aid_for_known_nonstudent'
      oracleIneligible.push(check)
    }
    return check
  })
  const opportunityOracle = {
    version: 'amy-bounded-ineligibility-v1',
    scope: [
      'canonical_accept_decision',
      'stable_opportunity_id',
      'opportunity_identity_present',
      'direct_award_kind',
      'known_nonstudent_student_aid_conflict',
    ],
    accepted_claims: accepted.length,
    checked_accepts: oracleChecks.length - oracleUnknowns.length,
    unknown_accepts: oracleUnknowns.length,
    known_conflicts: oracleIneligible.length,
    complete: accepted.length > 0 && oracleUnknowns.length === 0,
    status: accepted.length === 0
      ? 'not_applicable'
      : oracleUnknowns.length > 0
        ? 'unknown'
        : oracleIneligible.length > 0
          ? 'conflict'
          : 'checked',
    qualification_proven: false,
    limitation: 'Checks only contradictions supported by current synthetic fixtures; it does not prove full eligibility, qualification, or an award.',
    exception_classes: {
      ...oracleUnknowns.reduce((out, check) => {
        out[check.reason] = (out[check.reason] || 0) + 1
        return out
      }, {}),
      ...oracleIneligible.reduce((out, check) => {
        out[check.reason] = (out[check.reason] || 0) + 1
        return out
      }, {}),
    },
    checks: oracleChecks.slice(0, 25),
  }
  if (
    scenario?.expected &&
    (scenario.expected.needs?.length > 0) &&
    thesisNeeds.length === 0 &&
    thesisTypes.length === 0
  ) {
    findings.push(
      makeFinding(FINDING_TYPES.PROFILE_FIELD_MAPPING_MISS, {
        message: `Profile signals for ${scenario.label} did not flow into the discovery thesis (needs/types empty).`,
        excerpt: `expected needs=[${(scenario.expected.needs || []).join(', ')}] thesis needs=[] types=[]`,
        evidence: { ...baseEvidence, expected: scenario.expected, thesis_needs: thesisNeeds, thesis_types: thesisTypes },
      }),
    )
  }
  if (scenario?.expected?.state && !thesisState) {
    findings.push(
      makeFinding(FINDING_TYPES.GEO_RADIUS_ISSUE, {
        message: `Expected geographic state ${scenario.expected.state} did not reach the thesis location.`,
        excerpt: `expected_state=${scenario.expected.state} thesis_state=null`,
        evidence: { ...baseEvidence, expected_state: scenario.expected.state },
      }),
    )
  }

  // ── Institution / hyperlocal RECALL (crawler-intelligence signal) ──────────
  // The goal of the pipeline is smarter crawlers. A student committed to a named
  // school should get institution-specific scholarships; a profile with a county
  // should get hyperlocal awards. If the crawler stored results but NONE of them
  // reference the school / county, the open-web query breadth is the weakness —
  // route the finding at buildWebQueries so Anya/Sam evolve it. Only fires when
  // discovery actually produced candidates (else ZERO_RESULT already covers it).
  const recTitles = recommendations.map((r) => normLower(`${r.title || ''} ${r.sponsor || ''}`))
  const thesisSchools = Array.isArray(thesis.schools) ? thesis.schools.filter(Boolean) : []
  if (thesis.is_student && thesisSchools.length > 0 && recommendations.length > 0) {
    const missingSchools = thesisSchools.filter((s) => !titlesReference(recTitles, s))
    if (missingSchools.length === thesisSchools.length) {
      findings.push(
        makeFinding(FINDING_TYPES.INSTITUTION_RECALL_MISS, {
          message: `${scenario.label}: student committed to ${thesisSchools.join(', ')} but 0 of ${recommendations.length} results reference the school (no institution-specific scholarships found).`,
          excerpt: `schools=[${thesisSchools.join(' | ')}] field=${thesis.field_of_study || 'n/a'}`,
          evidence: { ...baseEvidence, schools: thesisSchools, field_of_study: thesis.field_of_study || null, results: recommendations.length },
        }),
      )
    }
  }
  // ── AWARD-AMOUNT recall (pipeline-$ visibility signal) ─────────────────────
  // Candidates without a per-award dollar amount produce a $0 Pipeline
  // Potential no matter how good recall is (the 2026-07-05 "$6,500 pipeline
  // with 118 real sources" class). Fires only on a meaningful sample where NOT
  // ONE candidate carries an amount — a single missing amount is normal (many
  // real awards are "amount varies"); a 0% amount rate on 5+ results means the
  // adapter/extractor lane feeding this profile shape drops dollars entirely.
  // DIRECTORY locators never carry a per-award amount BY DESIGN (a pointer to
  // program lists, not an award) — counting them made this finding fire on
  // shape alone. BENEFIT programs are the same class one door over: their
  // stated per-award semantic is "varies by applicant" (SSI, Pell, LIHEAP —
  // locatorUrlKind.js), so a benefit rec with no dollar figure measures the
  // program's design, not our extraction. Measure dollar recall against
  // grant-shaped candidates only; recs with no kind (older run shape) stay in
  // the denominator so real extraction gaps keep firing.
  const grantShaped = recommendations.filter(
    (r) => !['DIRECTORY', 'BENEFIT'].includes(String(r.kind ?? '').toUpperCase()),
  )
  const withAmount = grantShaped.filter(
    (r) => num(r.amount_max) > 0 || num(r.amount_min) > 0,
  )
  // A funder that states "amounts vary" / "contact us" — or whose page we READ
  // and which states no figure at all ('none_published') — has told us the
  // truth: there IS no per-award number to extract. Counting those rows as an
  // extraction gap measures the funder's disclosure, not our recall. Rows with
  // no status at all, or 'not_listed' (nobody has looked yet, or looked and the
  // answer was never written down), stay in the denominator — those are where a
  // real extraction miss hides.
  const amountUnknowable = grantShaped.filter((r) =>
    AMOUNT_UNKNOWABLE_STATUSES.has(String(r.amount_status ?? '').toLowerCase()),
  )
  const measurable = grantShaped.length - amountUnknowable.length
  if (measurable >= 5 && withAmount.length === 0) {
    // The MEASURABLE candidates are the concrete misses — name them. `subjects`
    // is the CANONICAL evidence key the code-brief pipeline reads
    // (buildCodeBrief reads `evidence.subjects`; the registry-driven totality
    // pass reads `evidence[actor.evidence_key]`). This finding used to point
    // its evidence_key at `grant_shaped` — a COUNT — so the owner's brief said
    // "Concrete subject(s): 8" and never named a single title (the same
    // canonical-key defect that once left institution_recall_miss briefs with
    // no school ever named).
    const unknowableSet = new Set(amountUnknowable)
    const subjects = grantShaped
      .filter((r) => !unknowableSet.has(r))
      .map((r) => String(r.title || '').trim())
      .filter(Boolean)
      .slice(0, 6)
    findings.push(
      makeFinding(FINDING_TYPES.AMOUNT_RECALL_MISS, {
        message: `${scenario.label}: 0 of ${measurable} grant-shaped stored candidates whose funder could state an award amount carry one — this profile shape's pipeline value will display ~$0 (amount extraction/adapter gap, not a recall gap).`,
        excerpt: grantShaped.slice(0, 4).map((r) => r.title).filter(Boolean).join('; '),
        evidence: {
          ...baseEvidence,
          results: recommendations.length,
          grant_shaped: grantShaped.length,
          measurable,
          amount_unknowable: amountUnknowable.length,
          with_amount: 0,
          subjects,
        },
      }),
    )
  }

  // TOKEN BOUNDARY, NOT SUBSTRING. This used to ask `t.includes(thesisCounty)`,
  // which SUPPRESSES the finding on a coincidence: a Kent County profile reads as
  // hyperlocally covered by "Kentucky Housing Corporation", an Ida County one by
  // anything naming "Florida". That is the 'ssi'-inside-'assistance' class, and
  // here it fails in the direction that HIDES a real recall gap. The canonical
  // rule is `titleStatesTerm` (config/profileDerivedFacts.js) — the same
  // term-inside-title matcher `crisisNeedRecall.rowNamesProfileCounty` uses for
  // exactly this question — so the two can never drift.
  const thesisCounty = thesis?.location?.county ? normLower(thesis.location.county).replace(/\b(county|parish|borough)\b/g, '').trim() : ''
  if (thesisCounty && recommendations.length > 0 && !recTitles.some((t) => titleStatesTerm(thesisCounty, t))) {
    findings.push(
      makeFinding(FINDING_TYPES.HYPERLOCAL_RECALL_MISS, {
        message: `${scenario.label}: profile in ${thesis.location.county} but 0 of ${recommendations.length} results are county/hyperlocal.`,
        excerpt: `county=${thesis.location.county}`,
        evidence: { ...baseEvidence, county: thesis.location.county, results: recommendations.length },
      }),
    )
  }

  // Source health.
  const failedSources = sources.filter(looksLikeFetchFailure)
  const urlIssueSources = sources.filter(looksLikeUrlIssue)
  if (failedSources.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.SOURCE_FETCH_FAILED, {
        message: `${failedSources.length}/${sources.length} planned source(s) failed for ${scenario.label}.`,
        excerpt: failedSources.map((s) => `${s.source_id}:${s.outcome || s.reason || '?'}`).slice(0, 6).join('; '),
        evidence: { ...baseEvidence, failed_sources: failedSources.map((s) => ({ id: s.source_id, outcome: s.outcome, reason: s.reason })) },
      }),
    )
  }
  if (urlIssueSources.length > 0) {
    findings.push(
      makeFinding(FINDING_TYPES.URL_INVALID, {
        message: `Source(s) reported URL/link problems for ${scenario.label}.`,
        excerpt: urlIssueSources.map((s) => `${s.source_id}:${s.reason || '?'}`).slice(0, 6).join('; '),
        evidence: { ...baseEvidence, url_issue_sources: urlIssueSources.map((s) => ({ id: s.source_id, reason: s.reason })) },
      }),
    )
  }

  // Outcome classification.
  let status
  if (stored === 0) {
    status = 'zero'
    const zr = run.zero_result || {}
    const zReason = zr.zero_result_reason || zr.reason || 'no_opportunities_stored'
    findings.push(
      makeFinding(FINDING_TYPES.ZERO_RESULT, {
        message: `Zero opportunities stored for ${scenario.label} (reason: ${zReason}).`,
        excerpt: `reason=${zReason} missing=[${(zr.missing_profile_fields || []).join(', ')}]`,
        evidence: {
          ...baseEvidence,
          zero_result_reason: zReason,
          missing_profile_fields: zr.missing_profile_fields || [],
          excluded_sources: zr.excluded_sources || [],
          expansions_tried: zr.expansions_tried || [],
          searched_sources: zr.searched_sources || [],
        },
      }),
    )
    if (looksLikeGeoIssue(zReason)) {
      findings.push(
        makeFinding(FINDING_TYPES.GEO_RADIUS_ISSUE, {
          message: `Zero-result reason for ${scenario.label} points at geographic scoping.`,
          excerpt: `reason=${zReason}`,
          evidence: { ...baseEvidence, zero_result_reason: zReason },
        }),
      )
    }
  } else if (accepted.length === 0) {
    if (review.length > 0 || topScore >= REVIEW_SCORE) {
      status = 'weak'
      // Say WHICH fact this is. A locator-only list is a DIRECT-AWARD COVERAGE
      // gap ("nothing but pointers reached this profile"), not a scoring gap —
      // and its top score belongs to a row the locator rule forbids from ever
      // accepting, so quoting it as "top score" is misleading by construction.
      const message = locatorOnly
        ? `${scenario.label}: ${stored} stored, but ZERO direct awards were recommended — all ${locatorRecs.length} recommendation(s) are DIRECTORY locators, which by the locator rule can never claim ACCEPT (best locator score ${topLocatorScore}). This is a direct-award COVERAGE gap for this category, not a scoring-weight gap.`
        : `${scenario.label}: ${stored} stored, but no ACCEPT — top direct-award score ${topDirectScore} (review-band only).`
      findings.push(
        makeFinding(FINDING_TYPES.WEAK_MATCH, {
          message,
          excerpt: `stored=${stored} accepted=0 direct=${directRecs.length} locators=${locatorRecs.length} top_direct=${topDirectScore} top_locator=${topLocatorScore}`,
          evidence: {
            ...baseEvidence,
            stored,
            // `top_score` keeps its historical meaning (max over the whole
            // recommendation list) so existing consumers do not silently shift.
            top_score: topScore,
            top_direct_score: topDirectScore,
            top_locator_score: topLocatorScore,
            review: review.length,
            direct_recommendations: directRecs.length,
            locator_recommendations: locatorRecs.length,
            locator_only: locatorOnly,
          },
        }),
      )
    } else {
      status = 'weak'
      findings.push(
        makeFinding(FINDING_TYPES.NO_QUALIFIED_MATCHES, {
          message: `${scenario.label}: ${stored} stored, but none reached the review/accept bands (top score ${topScore}).`,
          excerpt: `stored=${stored} top_score=${topScore}`,
          evidence: { ...baseEvidence, stored, top_score: topScore },
        }),
      )
    }
    if (topScore > 0 && topScore < DEFAULT_MIN_SCORE) {
      findings.push(
        makeFinding(FINDING_TYPES.SCORING_FLOOR_SUPPRESSION, {
          message: `${scenario.label}: best candidate (${topScore}) is below the pipeline floor (${DEFAULT_MIN_SCORE}); confirm the zero-result recovery ladder surfaces it.`,
          excerpt: `top_score=${topScore} floor=${DEFAULT_MIN_SCORE}`,
          evidence: { ...baseEvidence, top_score: topScore, floor: DEFAULT_MIN_SCORE },
        }),
      )
    }
  } else {
    status = 'ok'
  }

  return {
    ...baseEvidence,
    status,
    stored,
    accepted: accepted.length,
    review: review.length,
    top_score: topScore,
    // The locator split travels with the evaluation so the tuner can route a
    // weak category at the lever that can actually close it (buildApprovalQueue).
    direct_recommendations: directRecs.length,
    locator_recommendations: locatorRecs.length,
    top_direct_score: topDirectScore,
    locator_only: locatorOnly,
    sources_total: sources.length,
    sources_failed: failedSources.length,
    // Named so buildApprovalQueue can key the ledger on the source, not a
    // forever-open `source_health` blob. Same shape as the finding evidence.
    failed_sources: failedSources.map((s) => ({ id: s.source_id, outcome: s.outcome, reason: s.reason })),
    candidates,
    false_positives: falsePositives.length,
    // The offending TITLES, not just the count: proposeGenericTitleAdditions()
    // mines these for the generic phrasing that let the row through, which is
    // what makes the `relevance_precision` approval item actionable instead of
    // a number with no remedy attached.
    false_positive_titles: falsePositives.map((c) => c.title).filter(Boolean),
    ineligible_accepts: ineligibleAccepts.length,
    opportunity_oracle: opportunityOracle,
    findings,
  }
}

function tally(arr, keyFn) {
  const out = {}
  for (const item of arr) {
    const k = keyFn(item)
    if (k === undefined || k === null) continue
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * Assemble the full Anya handoff report from per-scenario evaluations.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {Array<object>} args.evaluations - from evaluateDiscovery()
 * @param {object} [args.meta] - { startedAt, completedAt, dryRun, options }
 * @returns {object} Anya-compatible report with amy_summary.
 */
/**
 * Turn a pipeline guard-escape audit result (from
 * `pipelineGuardEscapeAudit.runPipelineGuardEscapeAudit`) into evaluation-shaped
 * records carrying `pipeline_guard_escape` findings — the LEARNING half of the
 * owner directive.
 *
 * ONE evaluation per ESCAPED GATE, so each carries a homogeneous, gate-specific
 * blind-spot diagnosis (file + assertion). These records slot straight into the
 * evaluations list `buildApprovalQueue` consumes: its registry-driven totality
 * pass then mints ONE approval item per gate, at the `pipeline_guard_escape`
 * class's registered lever (`eligibility_gate` → CODE_CHANGE), and attaches a
 * code brief. `FINDING_TYPES.PIPELINE_GUARD_ESCAPE` is emitted HERE (in
 * amyReport.js) so the actor-registry totality test's `emitted:true` grep holds.
 *
 * @param {object} auditResult
 * @returns {Array<object>} evaluation-shaped records (empty when no escapes)
 */
export function buildGuardEscapeEvaluations(auditResult) {
  const audit = auditResult && typeof auditResult === 'object' ? auditResult : null
  if (!audit || !Array.isArray(audit.escapes) || audit.escapes.length === 0) return []

  const byGate = new Map()
  for (const esc of audit.escapes) {
    const gate = String(esc?.gate || 'unknown')
    const bucket = byGate.get(gate) || { profiles: new Set(), reasons: {}, subjects: [], items: [] }
    if (esc?.profile_id) bucket.profiles.add(esc.profile_id)
    const reason = esc?.reason || 'failed'
    bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1
    if (esc?.title) bucket.subjects.push(String(esc.title))
    bucket.items.push({ profile_id: esc?.profile_id ?? null, title: esc?.title ?? null, reason })
    byGate.set(gate, bucket)
  }

  const out = []
  for (const [gate, b] of byGate.entries()) {
    const bs = blindSpotForGate(gate)
    const subjects = [...new Set(b.subjects)].slice(0, 12)
    const removed = b.items.length
    const finding = {
      ...makeFinding(FINDING_TYPES.PIPELINE_GUARD_ESCAPE, {
        severity: SEVERITY.HIGH,
        message:
          `${removed} pipeline source(s) across ${b.profiles.size} real profile(s) FAILED the "${gate}" `
          + `criterion but had been admitted — a guard-escape (removed via the canonical tombstone). `
          + `Blind spot: ${bs.blind_spot}. Fix in ${bs.gate_file} (${bs.symbol}); ${bs.assertion}.`,
        evidence: {
          gate,
          gate_file: bs.gate_file,
          symbol: bs.symbol,
          blind_spot: bs.blind_spot,
          assertion: bs.assertion,
          profiles: b.profiles.size,
          escapes_removed: removed,
          reasons: b.reasons,
          subjects,
          escapes: b.items.slice(0, 20),
        },
      }),
      // Point the finding at the SPECIFIC gate's source (the totality pass reads
      // finding.file into `bucket.files`); the code brief still names the
      // admission choke point via CODE_TARGETS.
      file: bs.gate_file,
    }
    out.push({
      scenario_id: `guard_escape:${gate}`,
      category: `guard_escape:${gate}`,
      profile_id: null,
      status: 'ok',
      stored: removed,
      accepted: 0,
      review: 0,
      sources_failed: 0,
      false_positives: 0,
      ineligible_accepts: 0,
      findings: [finding],
    })
  }
  return out
}

export function buildAnyaHandoff({ runId, evaluations = [], meta = {} }) {
  const allFindings = []
  for (const ev of evaluations) {
    for (const f of ev.findings || []) allFindings.push(f)
  }

  const startedAt = meta.startedAt || new Date().toISOString()
  const completedAt = meta.completedAt || new Date().toISOString()
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))

  const filesWithFindings = new Set(allFindings.map((f) => f.file))
  const byFile = tally(allFindings, (f) => f.file)
  const recommendedFocus = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .map(([file, count]) => ({ file, findings: count }))
  const oracleExceptions = {}
  for (const evaluation of evaluations) {
    for (const [exceptionClass, count] of Object.entries(evaluation?.opportunity_oracle?.exception_classes || {})) {
      oracleExceptions[exceptionClass] = (oracleExceptions[exceptionClass] || 0) + Number(count || 0)
    }
  }

  const amySummary = {
    scenarios_total: evaluations.length,
    by_status: tally(evaluations, (e) => e.status),
    by_category: tally(evaluations, (e) => e.category),
    by_finding_type: tally(allFindings, (f) => f.type),
    by_severity: tally(allFindings, (f) => f.severity),
    source_health: {
      scenarios_with_source_failures: evaluations.filter((e) => num(e.sources_failed) > 0).length,
    },
    opportunity_oracle: {
      version: 'amy-bounded-ineligibility-v1',
      checked_profiles: evaluations.filter((evaluation) => evaluation?.opportunity_oracle?.status === 'checked').length,
      conflict_profiles: evaluations.filter((evaluation) => evaluation?.opportunity_oracle?.status === 'conflict').length,
      unknown_profiles: evaluations.filter((evaluation) => evaluation?.opportunity_oracle?.status === 'unknown').length,
      unavailable_profiles: evaluations.filter((evaluation) => !evaluation?.opportunity_oracle).length,
      accepted_claims: evaluations.reduce((sum, evaluation) => sum + num(evaluation?.opportunity_oracle?.accepted_claims), 0),
      unknown_accepts: evaluations.reduce((sum, evaluation) => sum + num(evaluation?.opportunity_oracle?.unknown_accepts), 0),
      known_conflicts: evaluations.reduce((sum, evaluation) => sum + num(evaluation?.opportunity_oracle?.known_conflicts), 0),
      exception_classes: oracleExceptions,
      qualification_proven: false,
    },
    recommended_focus: recommendedFocus,
  }

  return {
    // ── Anya report contract (mirrors runAutonomousCodeCrawl output) ──
    status: 'completed',
    generator: ORIGIN_AGENT,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    dry_run_requested: Boolean(meta.dryRun),
    dry_run_effective: Boolean(meta.dryRun),
    write_flag_enabled: false,
    files_discovered: filesWithFindings.size,
    files_scanned: 0,
    files_analyzed: 0,
    files_with_findings: filesWithFindings.size,
    findings_found: allFindings.length,
    findings_total: allFindings.length,
    findings: allFindings,
    findings_offset: 0,
    findings_limit: allFindings.length,
    findings_truncated: false,
    search_kind_breakdown: { [SEARCH_KIND]: allFindings.length },
    domain_audit_summary: null,
    errors: [],
    modifications: [],

    // ── Amy-specific handoff envelope ──
    handoff_from: 'amy',
    handoff_run_id: runId,
    handoff_options: meta.options || null,
    amy_summary: amySummary,
  }
}

/** Compact summary for CLI/run-log output. */
export function summarizeEvaluations(evaluations = []) {
  return {
    scenarios: evaluations.length,
    ok: evaluations.filter((e) => e.status === 'ok').length,
    weak: evaluations.filter((e) => e.status === 'weak').length,
    zero: evaluations.filter((e) => e.status === 'zero').length,
    skipped: evaluations.filter((e) => e.status === 'skipped').length,
    error: evaluations.filter((e) => e.status === 'error').length,
    oracle_checked: evaluations.filter((e) => e?.opportunity_oracle?.status === 'checked').length,
    oracle_conflict: evaluations.filter((e) => e?.opportunity_oracle?.status === 'conflict').length,
    oracle_unknown: evaluations.filter((e) => e?.opportunity_oracle?.status === 'unknown').length,
    oracle_unavailable: evaluations.filter((e) => !e?.opportunity_oracle).length,
    total_findings: evaluations.reduce((n, e) => n + (e.findings?.length || 0), 0),
  }
}

export default { evaluateDiscovery, buildAnyaHandoff, summarizeEvaluations }
