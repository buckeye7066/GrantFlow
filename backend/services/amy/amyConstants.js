/**
 * amyConstants.js
 *
 * Amy — synthetic crawler-training agent. Amy generates highly varied,
 * synthetic GrantFlow profiles, runs them through the existing Crawler OS
 * discovery pipeline, measures where crawlers succeed/fail, and emits a
 * structured handoff report for Anya (who evolves crawler code).
 *
 * SAFETY: Amy never uses real personal data. Every profile Amy creates is
 * tagged so Sam's cleanup can safely delete it. All Amy records are traceable
 * (origin_agent + run id + scenario id), logged, and reversible.
 *
 * This module is the single source of truth for the tags/markers, origin
 * identity, TTL bounds, finding taxonomy, and the map from a crawler-weakness
 * finding type to the real code location Anya should evolve. No magic strings
 * elsewhere in the Amy service.
 */

/** Value written to profiles.created_by — the robust, indexed cleanup key. */
export const ORIGIN_CREATED_BY = 'agent:amy'

/** Human-readable agent name (matches the metadata block contract). */
export const ORIGIN_AGENT = 'Amy'

/** Pipeline label stamped on every synthetic profile. */
export const PIPELINE = 'amy_crawler_training'

/** created_for marker. */
export const CREATED_FOR = 'crawler_training'

/** updated_by value for sections Amy writes. */
export const SECTION_WRITER = 'agent:amy'

/** Dedicated profile_sections key holding the full Amy metadata block. */
export const METADATA_SECTION_KEY = 'amy_metadata'

/**
 * Tag markers placed on profiles.tags (a JSON array string). These are for
 * traceability and easy SQL `LIKE` scanning; the authoritative cleanup gate is
 * created_by === ORIGIN_CREATED_BY plus allow_sam_cleanup in the metadata
 * section. Sam (or amy:cleanup) deletes only rows carrying ALL of these.
 */
export const TAG_SYNTHETIC = 'synthetic'
export const TAG_AGENT = 'amy'
export const TAG_PIPELINE = PIPELINE
export const TAG_ALLOW_CLEANUP = 'allow_sam_cleanup'

export const BASE_TAGS = Object.freeze([
  TAG_SYNTHETIC,
  TAG_AGENT,
  TAG_PIPELINE,
  TAG_ALLOW_CLEANUP,
])

/** TTL bounds (hours). Default 48h; clamp to 24–72h per the spec. */
export const TTL_MIN_HOURS = 24
export const TTL_DEFAULT_HOURS = 48
export const TTL_MAX_HOURS = 72

/**
 * Finding taxonomy — the kinds of crawler weakness Amy can detect by running a
 * synthetic profile through discovery. Each maps to a real code target below.
 */
export const FINDING_TYPES = Object.freeze({
  DISCOVERY_SKIPPED: 'discovery_skipped',
  CRAWLER_EXCEPTION: 'crawler_exception',
  SOURCE_FETCH_FAILED: 'source_fetch_failed',
  SOURCE_PARSE_FAILED: 'source_parse_failed',
  ZERO_RESULT: 'zero_result',
  WEAK_MATCH: 'weak_match',
  NO_QUALIFIED_MATCHES: 'no_qualified_matches',
  FALSE_POSITIVE: 'false_positive',
  BAD_MATCH: 'bad_match',
  SCORING_FLOOR_SUPPRESSION: 'scoring_floor_suppression',
  PROFILE_FIELD_MAPPING_MISS: 'profile_field_mapping_miss',
  POLICY_REJECTION: 'policy_rejection',
  URL_INVALID: 'url_invalid',
  GEO_RADIUS_ISSUE: 'geo_radius_issue',
  INSTITUTION_RECALL_MISS: 'institution_recall_miss',
  HYPERLOCAL_RECALL_MISS: 'hyperlocal_recall_miss',
  INELIGIBLE_MATCH: 'ineligible_match',
  AMOUNT_RECALL_MISS: 'amount_recall_miss',
  // A source that FAILS the canonical four-gate criteria (REAL / RELATABLE /
  // COVERS-A-NEED / QUALIFIES) but had nonetheless been admitted to a real
  // profile's pipeline. Amy removes it via the canonical tombstone at her reap
  // and DIAGNOSES how it escaped admission so the blind spot can be closed.
  PIPELINE_GUARD_ESCAPE: 'pipeline_guard_escape',
})

export const SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
})

/** Anya-compatible search_kind discriminator for Amy-sourced findings. */
export const SEARCH_KIND = 'amy_synthetic_training'

/**
 * Map a finding type → the real repo file (and a representative line) Anya
 * should inspect/evolve, plus a default severity. Paths are repo-relative so
 * they slot directly into Anya's findings[] shape (file/line). Anya scans the
 * filesystem, so these MUST point at real files that exist in the repo.
 */
export const CODE_TARGETS = Object.freeze({
  [FINDING_TYPES.DISCOVERY_SKIPPED]: {
    file: 'backend/services/crawlerOsService.js',
    line: 159,
    severity: SEVERITY.HIGH,
    hint: 'runProfileDiscoveryLive skipped this profile (lifecycle/status guard) — verify the synthetic profile status is discoverable.',
  },
  [FINDING_TYPES.CRAWLER_EXCEPTION]: {
    file: 'backend/services/crawlerOsService.js',
    line: 159,
    severity: SEVERITY.HIGH,
    hint: 'Discovery threw for this profile shape — harden the pipeline against this profile category.',
  },
  [FINDING_TYPES.SOURCE_FETCH_FAILED]: {
    file: 'backend/crawler-os/sourceRegistry.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'One or more planned sources failed before parsing — check transport/source health, blocking, rate limits, and missing API keys.',
  },
  [FINDING_TYPES.SOURCE_PARSE_FAILED]: {
    file: 'backend/crawler-os/adapters/index.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'A source fetched successfully but its adapter could not parse the response — update the adapter schema/body parser and pin the observed response shape in a test.',
  },
  [FINDING_TYPES.ZERO_RESULT]: {
    file: 'backend/services/zeroResultLadder.js',
    line: 88,
    severity: SEVERITY.HIGH,
    hint: 'No opportunities stored for this profile — planner source selection or query thesis is too narrow for this category.',
  },
  [FINDING_TYPES.WEAK_MATCH]: {
    file: 'backend/services/matchEngine.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'Opportunities were found but all scored weak — scoring under-credits this profile category.',
  },
  [FINDING_TYPES.NO_QUALIFIED_MATCHES]: {
    file: 'backend/services/matchEngine.js',
    line: 1,
    severity: SEVERITY.HIGH,
    hint: 'Candidates stored but none reached ACCEPT — decision thresholds or need/eligibility credit miss this category.',
  },
  [FINDING_TYPES.FALSE_POSITIVE]: {
    // The generic vocabulary, not the engine: the engine's generic-only ACCEPT
    // cap is structural and reads this registry, so the actionable remedy is a
    // vocabulary phrase (Amy's `relevance_precision` lever writes here).
    // Declared DIRECTORY locators are NOT false positives — they are pointers
    // admitted at REVIEW by the locator rule.
    file: 'backend/config/genericTitleVocabulary.js',
    line: 1,
    severity: SEVERITY.HIGH,
    hint: 'A generic-titled (non-locator) result was ACCEPTED for a specific profile — the generic vocabulary does not yet catch this phrasing, so the engine\'s generic-only ACCEPT cap could not hold it at REVIEW.',
  },
  [FINDING_TYPES.BAD_MATCH]: {
    file: 'backend/services/relevanceFilter.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'An accepted result is a borderline/likely-irrelevant match for this profile category — relevance/eligibility rules under-filter it.',
  },
  [FINDING_TYPES.SCORING_FLOOR_SUPPRESSION]: {
    file: 'backend/config/matchThresholds.js',
    line: 32,
    severity: SEVERITY.MEDIUM,
    hint: 'Real candidates exist but fall below DEFAULT_MIN_SCORE — confirm the zero-result recovery ladder surfaces them.',
  },
  [FINDING_TYPES.PROFILE_FIELD_MAPPING_MISS]: {
    file: 'backend/services/profile/applicationSchema.json',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'A profile signal Amy set did not flow into the thesis (needs/geo/type empty) — check the facet field mapping.',
  },
  [FINDING_TYPES.POLICY_REJECTION]: {
    file: 'backend/services/relevanceFilter.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'Results were dropped by a relevance/eligibility policy — verify the rule is not over-rejecting this category.',
  },
  [FINDING_TYPES.URL_INVALID]: {
    file: 'backend/services/opportunityValidationLayer.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'A stored opportunity had a missing/invalid application URL — tighten the adapter URL extraction.',
  },
  [FINDING_TYPES.GEO_RADIUS_ISSUE]: {
    file: 'backend/crawler-os/matchEngine.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'Geographic scoping looks wrong for this profile location — review geo expansion (city→county→state→national).',
  },
  [FINDING_TYPES.INSTITUTION_RECALL_MISS]: {
    file: 'backend/crawler-os/webQueries.js',
    line: 1,
    severity: SEVERITY.HIGH,
    hint: 'A student with a named/committed school got NO result referencing that school — the open-web lane is not searching institution-specific scholarships (endowed/departmental/foundation). Confirm buildWebQueries emits "<school> scholarships" / "<school> <field> scholarship" / "<school> foundation scholarships" and that the school reaches the thesis.',
  },
  [FINDING_TYPES.HYPERLOCAL_RECALL_MISS]: {
    file: 'backend/crawler-os/webQueries.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'A profile with a county got NO county/hyperlocal result — confirm buildWebQueries emits county-level queries ("scholarships <county>", "community foundation <county>") and that thesis.location.county is populated.',
  },
  // Eligibility mismatch: an opportunity the profile CANNOT apply for was ACCEPTED
  // (e.g. an enrolled-student scholarship — TN HOPE / FAFSA / Pell / TSAA — accepted
  // for a non-student individual/family, or an applicant-type/geo-exclusive award).
  // The lesson (2026-07-01): the eligibility GATE must reject/cap these at SCORING
  // time so they never ACCEPT; the surface-table net (surfacedEligibility.js) only
  // heals rows already persisted. Anya evolves the gate; Sam verifies a non-student
  // synthetic no longer accepts student-aid.
  [FINDING_TYPES.INELIGIBLE_MATCH]: {
    file: 'backend/services/matchEngine.js',
    line: 2288,
    severity: SEVERITY.HIGH,
    hint: 'A profile-INELIGIBLE opportunity was ACCEPTED. Evolve the eligibility gate so it never ACCEPTs: student-only aid (isStudentAidOpportunity) must REJECT/cap for a non-student (STUDENT_AID_NONSTUDENT_CAP + requiresStudent gate); applicant-type/geo-exclusive awards must fail the applicant/geo gate. Widen isStudentAidOpportunity (RE_STUDENT_AID_SIGNAL) to any leaking student-aid program brand. The nightly surfacedEligibility sweep (backend/services/coverageAudit/surfacedEligibility.js) is the NET that demotes stale ACCEPTs the reconcile never re-scores — keep it, but the goal is fewer ineligible ACCEPTs at the source.',
  },
  // Pipeline-$ visibility (the "$6,500 pipeline with 118 real sources" class,
  // 2026-07-05): discovery produced candidates but NONE carried a per-award
  // dollar amount, so the profile's Pipeline Potential reads ~$0 no matter how
  // good recall is. Structured feeds pass amount_min/amount_max through the
  // normalizer; text sources depend on awardAmountExtractor patterns. Amy's
  // synthetic cohorts should keep probing profile shapes whose likely sources
  // are text-first (hyperlocal community foundations, church/small-nonprofit
  // funds, web-llm scholarship pages) — those are where amount extraction gaps
  // hide, and where new extractor phrasings/adapter field maps are learned.
  [FINDING_TYPES.AMOUNT_RECALL_MISS]: {
    file: 'backend/services/awardAmountExtractor.js',
    line: 1,
    severity: SEVERITY.MEDIUM,
    hint: 'Stored candidates carry NO award amounts — the profile\'s pipeline value will read $0 even though recall is fine. If the sources are structured APIs, the adapter is dropping amount fields (map them into amount_min/amount_max). If the sources are web/text, extend extractAwardAmountsFromText with the phrasing seen on these pages (keep it per-award conservative — never program totals). The boot net (enforceGrantAmountBackfill) copies catalog amounts onto pipeline rows, but it cannot invent what ingest never captured.',
  },
  // A source that FAILS the canonical four-gate criteria was nonetheless admitted
  // to a real pipeline — an ADMISSION-gate blind spot. The single choke point
  // where all four gates should be enforced is admitToPipeline; the SPECIFIC gate
  // that should have caught THIS row (and the assertion that proves the fix) is
  // carried per-finding in `evidence.gate_file` / `evidence.assertion`.
  [FINDING_TYPES.PIPELINE_GUARD_ESCAPE]: {
    file: 'backend/services/opportunityMatcher.js',
    line: 244,
    severity: SEVERITY.HIGH,
    hint: 'A pipeline source failed the canonical REAL/RELATABLE/COVERS-A-NEED/QUALIFIES criteria but had been admitted — the admission gate (admitToPipeline) let it through. Close the specific gate named in the finding evidence so the class can never be re-admitted; the boot net (enforcePipelinePrecision) and Amy\'s reap audit are the removal NETs, not the fix.',
  },
})

export default {
  ORIGIN_CREATED_BY,
  ORIGIN_AGENT,
  PIPELINE,
  CREATED_FOR,
  SECTION_WRITER,
  METADATA_SECTION_KEY,
  BASE_TAGS,
  TTL_MIN_HOURS,
  TTL_DEFAULT_HOURS,
  TTL_MAX_HOURS,
  FINDING_TYPES,
  SEVERITY,
  SEARCH_KIND,
  CODE_TARGETS,
}
