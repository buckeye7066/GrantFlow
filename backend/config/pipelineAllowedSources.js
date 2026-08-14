/**
 * Canonical pipeline source policy.
 *
 * Per project rules:
 *   - "Hard boolean filters (AND logic) must be avoided unless the funding
 *     source is explicitly exclusive."
 *   - "Directory-style or general funding resources must always survive
 *     filtering unless explicitly excluded."
 *   - "null, undefined, or missing profile fields must NOT disqualify a
 *     funding source by default."
 *
 * The previous design was a strict allowlist that silently rejected every
 * source produced by the domain crawlers (e.g. "Student Endowments",
 * "Trade School Grants", "Workforce Development Grants" — all 60+ labels in
 * `services/crawlers/domainCrawlerRegistry.js`). That meant Discover Grants
 * surfaced legitimate funding opportunities the system had crawled, but the
 * "Add to Pipeline" button returned `400 source_not_allowed` for almost all
 * of them.
 *
 * This module now combines:
 *   1. An explicit ALLOWLIST of well-known, normalized canonical source ids
 *      (federal APIs, curated origins, geo crawler tags). Existing tests pin
 *      this list to keep behaviour explicit.
 *   2. An explicit DENYLIST of well-known unsafe markers (synthetic data,
 *      placeholder, spam, fake, template, regression test markers).
 *   3. A TRUSTED-LABEL heuristic that accepts any source string whose tokens
 *      look like a real funding-domain label ("Grants", "Scholarships",
 *      "Endowments", "Funding", "Benefits", "Support", "Aid", "Relief",
 *      "Foundation", "Programs", etc.). This is what the registry labels look
 *      like, so they all pass without having to hard-code each one.
 *
 * Result: Goal-7 directory resources reach the pipeline; only sources that
 * are either explicitly denied or look completely unrecognised get rejected.
 *
 * Sources included by category:
 *
 * Federal / National APIs:
 * - grants.gov / grants_gov   — Grants.gov REST API v2 + Simpler API
 * - usa_spending               — USASpending.gov API
 * - usaspending                — alt spelling
 *
 * Curated / Verified:
 * - verified_real              — manually verified real opportunities
 * - curated_benefits           — crawler-curated benefit programs
 * - curated                    — generic curated source tag
 *
 * Housing / Energy / Benefits:
 * - hud_cdbg                   — HUD Community Development Block Grant
 * - liheap                     — LIHEAP energy assistance
 * - snap_et                    — SNAP Employment & Training
 * - state_portal               — State benefits portals
 * - state_grants_portal        — State grants portals
 * - school_portal              — School/district portals
 *
 * Foundation / Community:
 * - local_foundation           — local foundation crawler results
 * - community_foundation       — community foundation programs
 * - cof_foundation_locator     — Council on Foundations locator
 * - candid_directory           — Candid/GuideStar directory
 *
 * Scholarships / Education:
 * - scholarship_crawler        — scholarship-focused crawlers
 * - scholarship_database       — scholarship database results
 *
 * Health / Social Services:
 * - health_resources_crawler   — health/medical resource crawlers
 * - charity_care               — hospital charity care programs
 * - workforce_training         — workforce training programs
 * - pro_bono_legal             — pro bono legal services
 *
 * Item / Goods:
 * - item_funding               — item-specific funding opportunities
 * - item_gift                  — gift/donation item opportunities
 * - in_kind                    — in-kind donation programs
 *
 * Corporate / Other:
 * - corporate_giving           — corporate giving programs
 *
 * Local Directories:
 * - local_directory_united_way        — United Way local directory
 * - local_directory_feeding_america   — Feeding America local directory
 * - local_directory_cap               — Community Action Partnership local directory
 * - osm_overpass                       — OpenStreetMap Overpass API (local resources)
 *
 * ECF / HCBS:
 * - ECF CHOICES                — TN ECF CHOICES Medicaid waiver
 * - ecf_choices                — lowercase variant
 * - ecf_benefits               — ECF/HCBS benefits crawler
 * - state_waiver               — state HCBS waiver programs
 */
export const PIPELINE_ALLOWED_SOURCES = [
  // Federal / National APIs
  'grants.gov',
  'grants_gov',
  'usa_spending',
  'usaspending',

  // User-initiated web-discovered leads (see web_search note in
  // TRUSTED_ORIGIN_SET below). Allowed by source as well as origin so an
  // explicit save still passes even if the client omits record_origin.
  'web_search',

  // Curated / Verified
  'verified_real',
  'curated_benefits',
  'curated',

  // Housing / Energy / Benefits
  'hud_cdbg',
  'liheap',
  'snap_et',
  'state_portal',
  'state_grants_portal',
  'school_portal',

  // Foundation / Community
  'local_foundation',
  'community_foundation',
  'cof_foundation_locator',
  'candid_directory',

  // Scholarships / Education
  'scholarship_crawler',
  'scholarship_database',

  // Health / Social Services
  'health_resources_crawler',
  'charity_care',
  'workforce_training',
  'pro_bono_legal',

  // Item / Goods
  'item_funding',
  'item_gift',
  'in_kind',

  // Corporate / Other
  'corporate_giving',

  // Foundation 990 data
  'propublica.990',

  // Opt-in clinical-trials connector (services/connectors/clinicalTrialsConnector.js
  // writes source `clinicaltrials.gov`). The brand string carries no
  // funding-domain token, so the TRUSTED_LABEL heuristic alone rejects it.
  // Listed by source as well as by origin for the same reason `web_search` is:
  // an explicit save must still pass when the client omits `record_origin`.
  'clinicaltrials.gov',
  'clinical_trials',

  // Local Directories
  'local_directory_united_way',
  'local_directory_feeding_america',
  'local_directory_cap',
  'osm_overpass',

  // ECF / HCBS Waivers
  'ECF CHOICES',
  'ecf_choices',
  'ecf_benefits',
  'state_waiver',

  // Discovery crawler generic source tags (from mapResultToFrontendShape)
  'federal',
  'national',
  'state',
  'scholarship',
  'school',
  'curated_program',

  // Curated startup seeds — push the NATIONAL_PROGRAMS + SCHOLARSHIPS data
  // files into funding_opportunities at server boot. Both seed modules are
  // explicitly authored content (not scraped); they must be pipeline-eligible
  // so the "Add to Pipeline" button works on every row they emit.
  'national_programs_seed',
  'scholarships_seed',

  // Well-known external scholarship/discovery platforms surfaced by referral
  // crawlers. These don't contain a generic funding token in their brand name
  // (so the heuristic alone won't pass them), but they are vetted referral
  // services that legitimately surface on Discover Grants.
  'bold.org',
  'bold_org',
  'scholarships.com',
  'scholarships_com',
  'fastweb',
  'fastweb.com',
  'cappex',
  'unigo',
  'salliemae',
  'studentaid.gov',
  'studentaid_gov',
  'collegescholarships.org',
  'niche',
  'going_merry',
  'goingmerry',
  'chegg',
];

export const PIPELINE_ALLOWED_SOURCES_SET = new Set(PIPELINE_ALLOWED_SOURCES);

/**
 * Sources that must NEVER reach a pipeline. Matched case-insensitively and
 * after normalizing whitespace/underscores. Tests pin: 'template', 'spam',
 * 'fake_source', 'regression_test'. Mirrors UNTRUSTED_SOURCES from
 * utils/recordOrigins.js so the pipeline gate stays consistent with the read
 * path and inserter validation.
 */
export const PIPELINE_DENIED_SOURCES = [
  'synthetic',
  'template',
  'fake',
  'fake_source',
  'spam',
  'spam_source',
  'regression_test',
  'placeholder',
  'untrusted',
  'unverified_external',
  'mock',
  'test_only',
  'demo_only',
];

const PIPELINE_DENIED_SET = new Set(PIPELINE_DENIED_SOURCES.map((s) => normalizeSourceKey(s)));
const PIPELINE_ALLOWED_NORM_SET = new Set(PIPELINE_ALLOWED_SOURCES.map((s) => normalizeSourceKey(s)));

/**
 * Tokens that mark a string as a "funding-domain label" — i.e. it looks like a
 * real crawler source and should be accepted by default. Tuned against every
 * label in `services/crawlers/domainCrawlerRegistry.js` plus the geo and
 * curated-domain crawlers, so any registry entry passes without needing to
 * be hard-coded into PIPELINE_ALLOWED_SOURCES.
 */
const TRUSTED_LABEL_TOKENS = [
  'grant', 'grants',
  'scholarship', 'scholarships', 'fellowship', 'fellowships',
  'endowment', 'endowments',
  'funding', 'fund', 'funds',
  'benefit', 'benefits',
  'aid',
  'relief',
  'support',
  'assistance',
  'voucher', 'vouchers',
  'foundation', 'foundations',
  'directory', 'portal',
  'program', 'programs',
  'service', 'services',
  'crawler',
  'waiver', 'waivers',
  'subsidy', 'subsidies',
  'stipend', 'stipends',
  'award', 'awards',
  'loan_forgiveness',
  'reentry',
  'training',
  'apprenticeship',
  // Tokens used by domain registry labels that don't carry a "grant"/"funding"
  // word but are still legitimate funding-program identifiers.
  'affairs',          // "Veteran Affairs Programs"
  'entrepreneurship', // "Military Spouse Entrepreneurship"
  'retraining',       // "Displaced Worker Retraining"
  'commission',       // "Appalachian Regional Commission"
  'opportunity', 'opportunities',
  'philanthropy',
  'charitable', 'charity',
  'nonprofit',
  'wellness',
  'workforce',
  // Geographic / institutional identifiers seen in geo + state crawlers.
  'agency',
  'department',
  'office',
  'bureau',
  'authority',
  'council',
  'institute',
  'center',
  'centers',
  'network',
  'corporation',
];

const TRUSTED_LABEL_TOKEN_SET = new Set(TRUSTED_LABEL_TOKENS);

/**
 * Normalize a source string: trim, lowercase, collapse runs of whitespace and
 * connector chars (`-`, `_`) to single underscores. Used for comparison only;
 * the original string is preserved for storage/display.
 */
export function normalizeSourceKey(source) {
  if (source === null || source === undefined) return '';
  return String(source)
    .toLowerCase()
    .trim()
    .replace(/[\s\-_/.]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Check if a funding opportunity source is allowed in profile pipelines.
 *
 * Decision order:
 *   1. Empty / null / undefined  → false (no source provenance to verify).
 *   2. Explicit denylist match   → false (synthetic/spam/template/etc.).
 *   3. Explicit allowlist match  → true  (canonical crawler ids).
 *   4. Trusted-label heuristic   → true  (any token in TRUSTED_LABEL_TOKENS,
 *      e.g. "Student Endowments", "Trade School Grants", "Veteran Affairs
 *      Programs", "UAW Strike Relief").
 *   5. Fallback                  → false (unknown / unrecognised marker).
 *
 * @param {string|null|undefined} source
 * @returns {boolean}
 */
export function isPipelineSourceAllowed(source) {
  if (!source) return false;
  const normalized = normalizeSourceKey(source);
  if (!normalized) return false;
  if (PIPELINE_DENIED_SET.has(normalized)) return false;
  if (PIPELINE_ALLOWED_NORM_SET.has(normalized)) return true;

  const tokens = normalized.split('_').filter(Boolean);
  for (const token of tokens) {
    if (TRUSTED_LABEL_TOKEN_SET.has(token)) return true;
  }
  return false;
}

/**
 * Record-origin values that are produced by trusted ingestion paths. Any
 * opportunity carrying one of these origins came from a vetted crawler /
 * curator, so its `source` label can be trusted even if the brand string
 * doesn't contain a funding-domain keyword (e.g. "Bold.org", "Fastweb").
 *
 * Mirrors `ALLOWED_RECORD_ORIGINS` from utils/recordOrigins.js minus the
 * untrusted markers ('synthetic', 'manual') so the pipeline gate stays in
 * lock-step with the read path and inserter validation.
 */
const TRUSTED_ORIGIN_SET = new Set([
  'live_crawl',
  'curated_verified',
  'curated_benefits',
  'curated_program',
  // Mirrors ALLOWED_RECORD_ORIGINS — curated startup seeds (NATIONAL_PROGRAMS
  // + SCHOLARSHIPS data files) are explicitly authored content and must be
  // accepted by the pipeline gate. Without this, every seeded row falls into
  // the "unknown_origin" branch and the "Add to Pipeline" button returns 400.
  'curated_catalog',
  'scholarship_crawler',
  'school_portal',
  'grants_gov',
  'verified_real',
  'cof_foundation_locator',
  'funding_api',
  // Opt-in clinical-trials connector. This is an ALLOWED_RECORD_ORIGIN in
  // utils/recordOrigins.js and is NOT one of the two deliberately excluded
  // untrusted markers ('synthetic', 'manual') — it was simply never mirrored
  // here. The connector writes record_origin 'clinical_trials' + source
  // 'clinicaltrials.gov', and neither string carries a TRUSTED_LABEL token, so
  // evaluatePipelineSource returned {allowed:false, reason:'unknown_source'}:
  // a study a profile had EXPLICITLY OPTED INTO surfaced in Discover and then
  // 400'd on "Add to Pipeline" — the exact defect this module's header says it
  // was rewritten to eliminate.
  'clinical_trials',
  'url_import',
  'directory_resource',
  'directory:health_resources',
  'directory:student_grants',
  'discovered',
  'geo_crawl',
  'seeded',
  'imported',
  // User-initiated web-discovered LEADS. These render low-trust on the display
  // side (opportunityTrust treats source_trust 'unknown' as low), but when a
  // user EXPLICITLY saves one to their pipeline it is a deliberate action on a
  // result with a real URL — permitted into the pipeline and persisted
  // profile-scoped via upsertFundingOpportunity. Not catalog-global.
  'web_search',
]);

/**
 * Decide whether an opportunity row may be saved into a profile pipeline.
 *
 * This is the **canonical** pipeline-gate predicate. It accepts the full
 * opportunity object so it can reason about both `source` (label) and
 * `record_origin` (provenance). An opportunity passes if:
 *
 *   • Its `record_origin` is in TRUSTED_ORIGIN_SET, OR
 *   • Its `source` passes `isPipelineSourceAllowed`.
 *
 * It is rejected when:
 *
 *   • The source matches the explicit denylist, OR
 *   • Both source and origin are unknown (no provenance to verify).
 *
 * @param {{source?: string|null, record_origin?: string|null} | null | undefined} opportunity
 * @returns {{ allowed: boolean, reason?: string, source?: string|null, record_origin?: string|null }}
 */
export function evaluatePipelineSource(opportunity) {
  const source = opportunity?.source ?? null;
  const recordOrigin = opportunity?.record_origin ?? null;
  const normalizedSource = normalizeSourceKey(source);
  const normalizedOrigin = normalizeSourceKey(recordOrigin);

  if (normalizedSource && PIPELINE_DENIED_SET.has(normalizedSource)) {
    return { allowed: false, reason: 'denied_source', source, record_origin: recordOrigin };
  }
  if (normalizedOrigin && (normalizedOrigin === 'synthetic' || normalizedOrigin === 'untrusted')) {
    return { allowed: false, reason: 'untrusted_origin', source, record_origin: recordOrigin };
  }

  if (normalizedOrigin && TRUSTED_ORIGIN_SET.has(normalizedOrigin)) {
    return { allowed: true, reason: 'trusted_origin', source, record_origin: recordOrigin };
  }
  if (source && isPipelineSourceAllowed(source)) {
    return { allowed: true, reason: 'allowed_source', source, record_origin: recordOrigin };
  }
  return {
    allowed: false,
    reason: source ? 'unknown_source' : 'missing_source',
    source,
    record_origin: recordOrigin,
  };
}
