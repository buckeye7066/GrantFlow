/**
 * Canonical allowlist of funding opportunity sources permitted in profile pipelines.
 *
 * Any opportunity whose `source` is NOT in this list must never be saved to the
 * grants (pipeline) table. This is the single source of truth — all pipeline
 * write paths and cleanup scripts import from here.
 *
 * Sources included:
 * - verified_real: manually verified real opportunities
 * - local_foundation: local foundation crawler results
 * - scholarship_crawler: scholarship-focused crawlers
 * - health_resources_crawler: health/medical resource crawlers
 * - item_funding: item-specific funding opportunities
 * - item_gift: gift/donation item opportunities
 * - local_directory_united_way: United Way local directory
 * - local_directory_feeding_america: Feeding America local directory
 * - local_directory_cap: Community Action Partnership local directory
 */
export const PIPELINE_ALLOWED_SOURCES = [
  'verified_real',
  'local_foundation',
  'scholarship_crawler',
  'health_resources_crawler',
  'item_funding',
  'item_gift',
  'local_directory_united_way',
  'local_directory_feeding_america',
  'local_directory_cap',
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
