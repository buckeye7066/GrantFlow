/**
 * Canonical allowlist of funding opportunity sources permitted in profile pipelines.
 *
 * Any opportunity whose `source` is NOT in this list must never be saved to the
 * grants (pipeline) table. This is the single source of truth — all pipeline
 * write paths and cleanup scripts import from here.
 *
 * IMPORTANT: Keep this list in sync with all crawler source values.
 * When adding a new crawler, add its source string here too.
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
];

export const PIPELINE_ALLOWED_SOURCES_SET = new Set(PIPELINE_ALLOWED_SOURCES);

/**
 * Check if a funding opportunity source is allowed in profile pipelines.
 * @param {string|null|undefined} source
 * @returns {boolean}
 */
export function isPipelineSourceAllowed(source) {
  if (!source) return false;
  return PIPELINE_ALLOWED_SOURCES_SET.has(String(source).trim());
}
