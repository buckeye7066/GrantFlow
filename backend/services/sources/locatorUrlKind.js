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
 * WHOLE-HOST rules (fix-cycle-3, prod census 2026-07-22). Each entry is a host
 * whose EVERY page is structurally a benefit program or a program directory —
 * there is no per-award figure anywhere on the domain, so a host-wide claim
 * over-claims nothing. Anything narrower (a host that mixes real awards with
 * program pages, like tn.gov, which carries BOTH the fixed-award HOPE
 * scholarship AND benefit program pages) must NOT be listed here — those rows
 * keep their ordinary read.
 *
 *   BENEFIT hosts — application/eligibility portals for need-based federal or
 *   state benefit programs (the FAFSA/Pell/SSI class): the honest per-award
 *   answer is "varies by applicant", which is what `benefit` kind states.
 *
 *   DIRECTORY hosts — pure service/program directories and funder-profile
 *   registries: pages ABOUT programs/funders, never an award of their own.
 */
const BENEFIT_HOSTS = Object.freeze([
  'studentaid.gov', // Federal Student Aid: FAFSA/Pell portal — need-based, no fixed award
  'tenncareconnect.tn.gov', // TennCare (Medicaid) application portal
  'fabenefits.dhs.tn.gov', // TN Family Assistance (SNAP/TANF) portal
])

const DIRECTORY_HOSTS = Object.freeze([
  'tn211.org', // 2-1-1 service directory
  'benefitscheckup.org', // NCOA benefit-finder directory
])

const RE_BENEFIT_HOST = new RegExp(
  `^https?:\\/\\/(?:www\\.)?(?:${BENEFIT_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?:[/?#]|$)`,
  'i',
)
const RE_DIRECTORY_HOST = new RegExp(
  `^https?:\\/\\/(?:www\\.)?(?:${DIRECTORY_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?:[/?#]|$)`,
  'i',
)

/**
 * ProPublica Nonprofit Explorer organization profile — a 990/funder registry
 * page about an ORGANIZATION (path is a bare EIN), never an award.
 */
const RE_PROPUBLICA_ORG = /^https?:\/\/projects\.propublica\.org\/nonprofits\/organizations\/\d+(?:[/?#]|$)/i

/**
 * Scholarships.com BROWSE-TREE pages — `/financial-aid/college-scholarships/
 * scholarships-by-<facet>/…` is the site's category directory (lists of
 * scholarships by major/state/type), a pointer to awards rather than an award.
 * Deliberately anchored on the `scholarships-by-` facet segment: an individual
 * scholarship page elsewhere on the host makes no claim here and keeps its
 * ordinary read.
 */
const RE_SCHOLARSHIPS_COM_CATEGORY =
  /^https?:\/\/(?:www\.)?scholarships\.com\/financial-aid\/college-scholarships\/(?:[a-z0-9-]+\/)*scholarships-by-[a-z0-9-]+(?:\/|[?#]|$)/i

/**
 * Ingest kinds a verified structural claim may override — generated defaults
 * observed in prod (an LLM/ingest stamping every row's shape), NOT curated
 * judgments. Exact strings; anything else (including the canonical
 * 'directory'/'benefit' and unknown future values) stays protected by the
 * never-overwrite rule. Lives HERE — next to the structural rules whose claims
 * outrank it — so the boot sweep (startup/enforceInvariants.js) and the
 * upsert writers (crawlerOsPersistence.js) can never drift on which stamps are
 * overridable: the tug-of-war this module's rules exist to end was exactly the
 * sweep and a writer disagreeing about who owns `opportunity_kind`.
 */
export const GENERIC_OVERRIDABLE_KINDS = Object.freeze(['PROGRAM', 'DIRECT_GRANT', 'SCHOLARSHIP', 'direct'])

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
  if (RE_BENEFIT_HOST.test(u)) {
    return { kind: 'benefit', reason: 'benefit_program_host' }
  }
  if (RE_DIRECTORY_HOST.test(u)) {
    return { kind: 'directory', reason: 'service_directory_host' }
  }
  if (RE_PROPUBLICA_ORG.test(u)) {
    return { kind: 'directory', reason: 'propublica_nonprofit_profile' }
  }
  if (RE_SCHOLARSHIPS_COM_CATEGORY.test(u)) {
    return { kind: 'directory', reason: 'scholarships_com_category' }
  }
  return null
}

/**
 * classifyLocatorKindFromRow — classify from the AUTHORITATIVE source_url ONLY.
 *
 * Sol fix-cycle-2 finding 2: a row whose PRIMARY crawl target (`source_url`) is a
 * real award/grant page must NEVER be demoted to directory/benefit by a SECONDARY
 * `application_url`/`evidence_url` that merely points at a locator (e.g. a
 * grants.gov award whose evidence_url is a sam.gov/fal assistance listing) — that
 * would HIDE a knowable amount and a real opportunity from the census/proposals.
 * When `source_url` is present, its shape is authoritative (a non-locator shape →
 * null = NOT demoted). Only when there is NO source_url do we fall back to a
 * secondary URL that is unambiguously a locator/benefit. Pure.
 */
export function classifyLocatorKindFromRow(row) {
  const source = typeof row?.source_url === 'string' ? row.source_url.trim() : ''
  if (source) return classifyLocatorKindFromUrl(source)
  for (const url of [row?.application_url, row?.evidence_url]) {
    const hit = classifyLocatorKindFromUrl(url)
    if (hit) return hit
  }
  return null
}

/**
 * SQL LIKE prefilters for the `locator_kind_classification` boot sweep — one
 * per positive rule above, kept HERE so the sweep's candidate scan can never
 * drift from the classifier (fix-cycle-3 gate finding: the sweep prefiltered
 * only the two original hosts, so newer rules were never invoked on prod
 * rows). The prefilter only NARROWS the scan; the pure classifier above makes
 * every real decision, so an over-broad LIKE hit is harmless.
 */
export const LOCATOR_URL_LIKE_PREFILTERS = Object.freeze([
  '%sam.gov/fal/%',
  '%ssa.gov/%',
  ...BENEFIT_HOSTS.map((h) => `%${h}/%`),
  ...DIRECTORY_HOSTS.map((h) => `%${h}/%`),
  '%projects.propublica.org/nonprofits/organizations/%',
  '%scholarships.com/financial-aid/college-scholarships/%',
])

export default { classifyLocatorKindFromUrl, classifyLocatorKindFromRow, LOCATOR_URL_LIKE_PREFILTERS, GENERIC_OVERRIDABLE_KINDS }
