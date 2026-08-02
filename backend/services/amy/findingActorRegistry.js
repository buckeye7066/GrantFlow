/**
 * findingActorRegistry.js — EVERY FINDING CLASS HAS AN ACTOR, OR THE BUILD FAILS.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (2026-08-02)
 * -------------------------------------------
 * `buildApprovalQueue` builds items from FIVE evaluation fields — `status`
 * ('zero' / 'weak'), `false_positives`, `ineligible_accepts`, `sources_failed` —
 * and from NOTHING else. It has never read `e.findings`. So a finding class the
 * detectors emit but those five fields do not summarize could not become an
 * approval item, could not acquire a lever, could not enter the durable ledger
 * (#1085), and could not be closed by anything. It was simply re-counted nightly.
 *
 * MEASURED IN PROD, `system_kv amy_flywheel_cohort`, 21 retained ET days:
 *   institution_recall_miss   21 of 21 days, 282 occurrences   never green
 *   amount_recall_miss        16 of 21 days, 654 occurrences   never green
 *   hyperlocal_recall_miss     8 of 21 days, 480 occurrences
 *   source_fetch_failed       16 of 21 days,  76 occurrences
 * against `weak_match` on 2 days (11 occurrences) — which LED the report,
 * because it was one of the five things the queue could see.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A TOTAL map from `FINDING_TYPES` to the actor that can close it. Three fields
 * carry the whole contract:
 *
 *   lever        the named mechanism, resolved through the SAME
 *                `LEVER_REGISTRY` the approval ledger already uses, so a
 *                finding and an approval item can never disagree about how a
 *                thing gets fixed.
 *   emitted      whether `evaluateDiscovery` can actually produce this class
 *                today. A declared-but-unemitted class is honest dead
 *                vocabulary, not a coverage hole — but it must be SAID, not
 *                discovered later.
 *   evidence_key which field of the finding's `evidence` names the concrete
 *                work (`schools`, `county`, `failed_sources`…), so an item
 *                says what to do rather than how many times it happened.
 *
 * `amyFindingActorTotality.test.js` asserts:
 *   (a) every value of `FINDING_TYPES` appears here — a new class with no actor
 *       FAILS THE BUILD rather than sitting in a report for three weeks;
 *   (b) every `lever` named here is registered in `LEVER_REGISTRY`;
 *   (c) every emitted class is reachable from `evaluateDiscovery`'s source, and
 *       every class marked `emitted:false` is NOT — the flag cannot rot;
 *   (d) no lever whose surface is on the autonomy denylist is AUTO.
 *
 * THE AUTONOMY BOUNDARY (owner directive 2026-08-02)
 * -------------------------------------------------
 * Amy may APPLY a correction herself only when it is bounded, reversible, and
 * validated by a re-crawl with automatic revert. She may NOT autonomously
 * change matching logic, eligibility gates, scoring math, security or auth.
 * That line is a REGISTRY here (`SURFACE_CLASSES` + `AUTONOMY_FORBIDDEN`), not
 * a condition scattered through the agent, so it can be read in one place and
 * mutation-tested. `assertAutonomyBoundary()` is what enforces it, and the test
 * proves it FAILS when a forbidden lever is flipped to AUTO.
 */

import { FINDING_TYPES } from './amyConstants.js'
import { ACTIONABILITY, LEVER_REGISTRY } from './approvalLedger.js'

/**
 * The kind of thing a lever touches. The classification is what the safety
 * boundary is expressed over, so a new lever must declare one.
 */
export const SURFACE_CLASSES = Object.freeze({
  /** A DB/kv-backed knob. No code changes; revert is a write. */
  TUNABLE_DATA: 'tunable_data',
  /** A curated word list / alias map / registry row. Additive, revertible. */
  VOCABULARY: 'vocabulary',
  /** A crawler SOURCE (base_url fetch-verified before adoption). */
  SOURCE_REGISTRY: 'source_registry',
  /** The match engine's decision logic. */
  MATCHING_LOGIC: 'matching_logic',
  /** Eligibility gates (who may receive an award). */
  ELIGIBILITY: 'eligibility',
  /** Scoring math / thresholds that decide what a score MEANS. */
  SCORING_MATH: 'scoring_math',
  /** Fetching, parsing, adapters, extraction. */
  ADAPTER_CODE: 'adapter_code',
  /** Profile→thesis field mapping. */
  FIELD_MAPPING: 'field_mapping',
  /** Anything auth/tenancy/secret related. */
  SECURITY: 'security',
  /** Amy's own harness. */
  HARNESS: 'harness',
})

/**
 * Surfaces NO autonomous apply may ever touch.
 *
 * These are the surfaces where a wrong change is not merely unhelpful but
 * actively harmful: it can hand an applicant an award they cannot receive,
 * suppress one they can, or open a tenancy hole. The correct autonomous act for
 * these is to produce a precise, evidence-carrying CODE BRIEF — never an edit.
 *
 * `scoring_math` is on this list even though Amy already tunes the score FLOOR:
 * the floor is a `tunable_data` knob with a hard clamp and a proven cohort
 * sweep, which is a different object from the scoring formula. The distinction
 * is the whole reason the surface class is declared per LEVER rather than per
 * file.
 */
export const AUTONOMY_FORBIDDEN = Object.freeze([
  SURFACE_CLASSES.MATCHING_LOGIC,
  SURFACE_CLASSES.ELIGIBILITY,
  SURFACE_CLASSES.SCORING_MATH,
  SURFACE_CLASSES.SECURITY,
])

/**
 * lever → the surface it touches. TOTAL over `LEVER_REGISTRY` plus the levers
 * this module introduces; the totality test asserts both directions.
 */
export const LEVER_SURFACE = Object.freeze({
  source_keyword_coverage: SURFACE_CLASSES.SOURCE_REGISTRY,
  scoring_weights: SURFACE_CLASSES.TUNABLE_DATA,
  relevance_precision: SURFACE_CLASSES.VOCABULARY,
  eligibility_gate: SURFACE_CLASSES.ELIGIBILITY,
  adapter_source_health: SURFACE_CLASSES.ADAPTER_CODE,
  query_breadth: SURFACE_CLASSES.ADAPTER_CODE,
  archetype_query_learning: SURFACE_CLASSES.TUNABLE_DATA,
  score_floor: SURFACE_CLASSES.TUNABLE_DATA,
  amount_adapter: SURFACE_CLASSES.ADAPTER_CODE,
  profile_field_mapping: SURFACE_CLASSES.FIELD_MAPPING,
  geo_scope: SURFACE_CLASSES.MATCHING_LOGIC,
  url_hygiene: SURFACE_CLASSES.ADAPTER_CODE,
  crawler_hardening: SURFACE_CLASSES.ADAPTER_CODE,
  probe_harness: SURFACE_CLASSES.HARNESS,
  relevance_policy: SURFACE_CLASSES.MATCHING_LOGIC,
})

/**
 * THE TOTALITY MAP. One entry per `FINDING_TYPES` value.
 *
 * `emitted` is measured against `amyReport.evaluateDiscovery` and asserted by
 * the totality test — it is a fact about the code, not a comment.
 */
export const FINDING_ACTORS = Object.freeze({
  [FINDING_TYPES.ZERO_RESULT]: {
    lever: 'source_keyword_coverage',
    emitted: true,
    evidence_key: 'excluded_sources',
    note: 'Amy widens the mapped source lane and re-crawls; the change auto-reverts when cohort quality does not improve.',
  },
  [FINDING_TYPES.WEAK_MATCH]: {
    lever: 'scoring_weights',
    emitted: true,
    evidence_key: 'top_direct_score',
    note: 'A locator-only weak result is routed to source coverage instead (crawlerTuner splits them); a genuinely weak DIRECT award is a weight question.',
  },
  [FINDING_TYPES.NO_QUALIFIED_MATCHES]: {
    lever: 'scoring_weights',
    emitted: true,
    evidence_key: 'top_score',
  },
  [FINDING_TYPES.FALSE_POSITIVE]: {
    lever: 'relevance_precision',
    emitted: true,
    evidence_key: 'false_positive_titles',
  },
  [FINDING_TYPES.INELIGIBLE_MATCH]: {
    lever: 'eligibility_gate',
    emitted: true,
    evidence_key: 'ineligible_titles',
  },
  [FINDING_TYPES.SOURCE_FETCH_FAILED]: {
    lever: 'adapter_source_health',
    emitted: true,
    evidence_key: 'failed_sources',
  },
  // ── The classes that had NO actor before this module ────────────────────
  [FINDING_TYPES.INSTITUTION_RECALL_MISS]: {
    // RECLASSIFIED to `query_breadth` (CODE_CHANGE) 2026-08-02, reconciling
    // #1097 (this registry, which declared it AUTO) with #1095 (the runtime
    // branch in crawlerTuner, which emitted `query_breadth`). Merging both left
    // `main` RED: the registry and the runtime contradicted each other.
    //
    // The header measurement above is the verdict: 21 of 21 days, 282
    // occurrences, NEVER GREEN. The DATA half of this lever has been applied
    // every single night for three weeks and has not closed it, so declaring it
    // AUTO told the owner "Amy has this" while nothing converged — the
    // green-while-doing-nothing anti-pattern this codebase keeps re-finding.
    // `approvalLedger.js` already reached the same conclusion for
    // `query_breadth`: "a class that keeps firing after the steering store has
    // been recording it for weeks is evidence the QUERY BUILDER needs the
    // change". Amy still applies the data-side steering store; what changes is
    // that the residual now reaches the owner as a code brief.
    lever: 'query_breadth',
    emitted: true,
    evidence_key: 'schools',
    // This one is not "no lever" — it is "a lever that is running and not
    // closing it", which is a different diagnosis and a different fix. Prod's
    // `amy_archetype_learning` on 2026-08-02 holds
    // `student -> classes:['institution_gap'], caused_by:['institution_recall_miss']`
    // written by the 2026-08-02 run, and `attachLearnedGaps` feeds it into
    // `buildWebQueries` on every live crawl. The lesson has been re-learned for
    // weeks while the finding stayed at 4-12 profiles a night. Routing it here
    // is what finally makes the ledger AGE it, so "applied every night, never
    // closes" becomes visible instead of invisible.
    note: 'Auto-applied by the archetype query-steering store (SAFE_LEARNED_CLASSES institution_gap) which buildWebQueries consumes.',
  },
  [FINDING_TYPES.HYPERLOCAL_RECALL_MISS]: {
    lever: 'query_breadth',
    emitted: true,
    evidence_key: 'county',
    note: 'Same steering store (class hyperlocal_gap), same reclassification, same reason as institution_recall_miss above.',
  },
  [FINDING_TYPES.AMOUNT_RECALL_MISS]: {
    lever: 'amount_adapter',
    emitted: true,
    evidence_key: 'grant_shaped',
    note: 'Needs an adapter or an extractor phrasing. Amy cannot write either — reported as a code brief naming the hosts.',
  },
  [FINDING_TYPES.PROFILE_FIELD_MAPPING_MISS]: {
    lever: 'profile_field_mapping',
    emitted: true,
    evidence_key: 'expected',
    note: 'A profile signal never reached the thesis. This is the class that made five military checks dead code on the live path (gatherStructuredApplicantHints reads section.data; profileContextToThesisInput supplies {title, body}).',
  },
  [FINDING_TYPES.GEO_RADIUS_ISSUE]: {
    lever: 'geo_scope',
    emitted: true,
    evidence_key: 'expected_state',
  },
  [FINDING_TYPES.SCORING_FLOOR_SUPPRESSION]: {
    lever: 'score_floor',
    emitted: true,
    evidence_key: 'top_score',
    note: 'Amy already sweeps the floor over the whole cohort and applies a bounded, hard-clamped change (decideFloorChange). This class simply never named it.',
  },
  [FINDING_TYPES.URL_INVALID]: {
    lever: 'url_hygiene',
    emitted: true,
    evidence_key: 'url_issue_sources',
    note: 'enforceApplicationUrlRescue is the standing boot actor; a class that keeps firing means the rescue is not reaching these rows.',
  },
  [FINDING_TYPES.CRAWLER_EXCEPTION]: {
    lever: 'crawler_hardening',
    emitted: true,
    evidence_key: 'error',
  },
  [FINDING_TYPES.DISCOVERY_SKIPPED]: {
    lever: 'probe_harness',
    emitted: true,
    evidence_key: 'reason',
    note: 'A synthetic profile discovery refused to run is a defect in Amy\'s OWN harness, not in the crawlers.',
  },
  // ── Declared vocabulary with no detector. Said out loud, not discovered. ──
  [FINDING_TYPES.BAD_MATCH]: {
    lever: 'relevance_precision',
    emitted: false,
    evidence_key: null,
    note: 'No detector emits this. The false_positive detector subsumed it when the generic-only cap shipped.',
  },
  [FINDING_TYPES.POLICY_REJECTION]: {
    lever: 'relevance_policy',
    emitted: false,
    evidence_key: null,
    note: 'No detector emits this. Policy rejections are visible as zero_result reasons instead.',
  },
})

/** Levers that exist only in this module (not yet in LEVER_REGISTRY). */
export function unregisteredLevers() {
  return [...new Set(Object.values(FINDING_ACTORS).map((a) => a.lever))]
    .filter((l) => !LEVER_REGISTRY[l])
}

/**
 * The single safety gate. Throws when a lever whose surface is on the autonomy
 * denylist is declared AUTO.
 *
 * Called at module load of the registry test AND from `buildApprovalQueue`'s
 * totality path, so a future edit that quietly makes the eligibility gate
 * auto-appliable cannot ship.
 */
export function assertAutonomyBoundary(registry = LEVER_REGISTRY, surfaces = LEVER_SURFACE) {
  const violations = []
  for (const [lever, entry] of Object.entries(registry || {})) {
    const surface = surfaces[lever]
    if (!surface) { violations.push(`${lever}: no declared surface class`); continue }
    if (entry?.actionability === ACTIONABILITY.AUTO && AUTONOMY_FORBIDDEN.includes(surface)) {
      violations.push(`${lever}: AUTO is forbidden on surface "${surface}"`)
    }
  }
  if (violations.length > 0) {
    throw new Error(`Amy autonomy boundary violated: ${violations.join('; ')}`)
  }
  return true
}

/** The actor for one finding type (never throws; unknown → an honest null). */
export function actorFor(findingType) {
  return FINDING_ACTORS[String(findingType ?? '')] || null
}

/** The finding types with no actor at all — the totality test's failure set. */
export function actorlessFindingTypes() {
  return Object.values(FINDING_TYPES).filter((t) => !FINDING_ACTORS[t])
}

export default {
  SURFACE_CLASSES,
  AUTONOMY_FORBIDDEN,
  LEVER_SURFACE,
  FINDING_ACTORS,
  actorFor,
  actorlessFindingTypes,
  unregisteredLevers,
  assertAutonomyBoundary,
}
