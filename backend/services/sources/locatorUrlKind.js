/**
 * locatorUrlKind.js — POSITIVE structural URL-shape classification for catalog
 * rows whose page is a PROGRAM LOCATOR / BENEFIT page, never an award.
 *
 * WHY THIS EXISTS (prod triage 2026-07-21). The amount-answer census
 * (`pipeline.amountCoverage`) carried two large honest-MISS blocks that no
 * amount of fetching can ever answer:
 *
 *   - 43 sam.gov `/fal/<uuid>/view` rows — SAM.gov Assistance Listings (the
 *     CFDA program directory). An assistance-listing page describes a federal
 *     PROGRAM and points at where its opportunities are posted; it is a
 *     locator, and per the amount-answer doctrine (repo CLAUDE.md, mirrored in
 *     the census's own recommended_fix) a locator/program page is a POINTER,
 *     never an award.
 *   - 30 ssa.gov benefit pages (`/survivor`, `/disability`, …) — federal
 *     BENEFIT programs with no fixed per-applicant award figure (the
 *     FAFSA/Pell/SSI class the census's recommended_fix already names as
 *     "classify as a BENEFIT/DIRECTORY kind so it counts as
 *     no-amount-by-design").
 *
 * DOCTRINE GUARDS. These rows leave the census denominator ONLY by POSITIVE
 * structural classification of what the page IS — never by fabricating a
 * `none_published` denial for a page that was never read (silence is not a
 * denial; `none_published` requires page_read===true && found===false). This
 * module is that positive rule: a pure, deterministic URL-shape match against
 * two known federal hosts. Anything short of an exact shape match returns
 * null — no fuzzy hostname matching, no path guessing, no over-claiming.
 *
 * Consumed by the `locator_kind_classification` boot sweep
 * (startup/enforceInvariants.js), which persists the kind onto
 * funding_opportunities.opportunity_kind — and ONLY where no kind was ever
 * recorded, so an honest classification some other writer made is never
 * overwritten.
 */

/**
 * SAM.gov Assistance Listing detail page: `sam.gov/fal/<uuid>/view`.
 * The path segment is the listing's UUID (hex + dashes) — a real one is
 * 32 hex chars / 36 with dashes; the 20..64 band tolerates format drift
 * without ever matching a non-id segment (letters outside a-f fail).
 */
const RE_SAM_ASSISTANCE_LISTING =
  /^https?:\/\/(?:www\.)?sam\.gov\/fal\/[0-9a-f][0-9a-f-]{18,62}[0-9a-f]\/view(?:[/?#]|$)/i

/**
 * SSA benefit-program sections. A POSITIVE list — each entry is a top-level
 * ssa.gov section that is a federal benefit program (no fixed per-applicant
 * award), verified against the shapes seen in prod. NOT a catch-all for
 * ssa.gov: an unlisted path stays unclassified rather than being guessed at.
 */
const SSA_BENEFIT_SECTIONS = Object.freeze([
  'survivor',
  'survivors',
  'disability',
  'ssi',
  'retirement',
  'benefits',
  'medicare',
])

const RE_SSA_BENEFIT = new RegExp(
  `^https?:\\/\\/(?:www\\.)?ssa\\.gov\\/(?:${SSA_BENEFIT_SECTIONS.join('|')})(?:[/?#]|$)`,
  'i',
)

/**
 * classifyLocatorKindFromUrl — pure, deterministic, never throws.
 *
 * @param {unknown} url a row's source/application/evidence URL
 * @returns {{ kind: 'directory'|'benefit', reason: string } | null}
 *   `kind` matches the funding_opportunities.opportunity_kind enum
 *   ('directory' = program locator/pointer, 'benefit' = benefit program);
 *   null = this rule makes NO claim about the URL (the honest default).
 */
export function classifyLocatorKindFromUrl(url) {
  const u = typeof url === 'string' ? url.trim() : ''
  if (!u) return null
  if (RE_SAM_ASSISTANCE_LISTING.test(u)) {
    return { kind: 'directory', reason: 'sam_gov_assistance_listing' }
  }
  if (RE_SSA_BENEFIT.test(u)) {
    return { kind: 'benefit', reason: 'ssa_benefit_program' }
  }
  return null
}

/**
 * classifyLocatorKindFromRow — first positive claim across the row's URLs
 * (same precedence the enrichment sweep reads them in). Pure.
 */
export function classifyLocatorKindFromRow(row) {
  for (const url of [row?.source_url, row?.application_url, row?.evidence_url]) {
    const hit = classifyLocatorKindFromUrl(url)
    if (hit) return hit
  }
  return null
}

export default { classifyLocatorKindFromUrl, classifyLocatorKindFromRow }
