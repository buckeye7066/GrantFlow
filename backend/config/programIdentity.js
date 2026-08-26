/**
 * programIdentity.js — "are these two rows the SAME PROGRAM?"
 *
 * ONE implementation, consumed by every surface that needs it. Extracted from
 * `services/robert/robertPipelineAudit.js` on 2026-08-25 because the predicate
 * was correct but reachable only from Robert's audit, while the OWNER-FACING
 * read path (`matching/fundingSourcePresentation.js`) deduped with a Map keyed
 * on `canonicalOpportunityKey` — a hash. Robert's own comment already recorded
 * why that cannot work:
 *
 *   "A hash key alone cannot answer this, because the owner's own duplicate
 *    list is made of SUBSET pairs, not equal ones ... it is why the dedup is a
 *    pairwise predicate rather than a Map key."
 *
 * Measured on one real profile's live rows (2026-08-25): the canonical-key
 * dedup collapsed 0 of 10 and left SEVEN duplicate pairs on screen —
 * "Family Support Program" x4, "Katie Beckett Waiver"/"Katie Beckett Program",
 * "1915(c) HCBS Waivers"/"TennCare 1915(c) HCBS Waivers". A list that repeats
 * itself reads as a list with nothing in it.
 *
 * This file adds NO new identity rule. It is a move + a re-export, so the two
 * consumers cannot drift (the `funder`/`sponsor` naming-drift class).
 *
 * The FUNDER is deliberately NOT part of the key: the owner's own examples pair
 * the same program with two different funder spellings ("Federal Student Aid"
 * vs "U.S. Department of Education").
 */
import { canonicalOpportunityKey } from '../crawler-os/contract.js'
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js'

export const IDENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'at', 'in', 'to', 'on',
  'program', 'programs', 'grant', 'grants', 'scholarship', 'scholarships',
  'fund', 'funds', 'award', 'awards', 'federal', 'national', 'initiative',
  // "Scholars" is a suffix half the scholarship world uses ("Coca-Cola
  // Scholars" / "Coca-Cola Scholars Program"); it names no program on its own.
  'scholars',
])

/** Institution/year qualifiers that a variant appends to the same program. */
export function stripProgramQualifiers(title) {
  return String(title || '')
    .replace(/\((?:\s*20\d{2}\s*[-–/]?\s*\d{0,4}\s*)\)/g, ' ')
    .replace(/\b20\d{2}\s*[-–/]\s*\d{2,4}\b/g, ' ')
    .replace(/\bat\s+.*$/i, ' ')
    .replace(/\s*[-–—]\s*.*$/, ' ')
}

/** The distinctive tokens of a program name, qualifiers stripped. */
export function programTokens(row) {
  return [...new Set(
    stripProgramQualifiers(row?.title)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !IDENTITY_STOPWORDS.has(t)),
  )].sort()
}

export function programIdentityKey(row) {
  const canonical = row?.canonical_opportunity_key
  if (typeof canonical === 'string' && canonical.trim()) return `c:${canonical.trim().toLowerCase()}`
  const tokens = programTokens(row)
  if (tokens.length > 0) return `t:${tokens.join('-')}`
  const derived = canonicalOpportunityKey({
    external_id: row?.external_id ?? null,
    title: row?.title ?? null,
    sponsor: row?.sponsor ?? null,
    url: row?.application_url || row?.source_url || null,
  })
  return derived ? `k:${derived}` : `g:${row?.grant_id}`
}

export const MIN_LONE_TOKEN_IDENTITY_LENGTH = 6

/**
 * QUALIFIER TOKENS — words a VARIANT of the same program adds: a state, an
 * institution word, a scope word. Read out of `STATE_REGISTRY` so a state name
 * cannot be missed by a hand-typed list.
 *
 * The distinction this encodes: "Tennessee HOPE Scholarship" differs from "HOPE
 * Scholarship" by a PLACE; "Gates Millennium Scholars" differs from "Gates
 * Scholarship" by a PROGRAM WORD. The first pair is one program, the second is
 * two — and no length or overlap heuristic can tell them apart.
 */
export const QUALIFIER_TOKENS = (() => {
  const out = new Set([
    'state', 'statewide', 'university', 'college', 'community', 'county', 'city',
    'regional', 'district', 'campus', 'institute', 'school', 'usa', 'us',
    'undergraduate', 'graduate', 'general', 'annual',
  ])
  for (const entry of Object.values(STATE_REGISTRY || {})) {
    for (const word of String(entry?.name ?? '').toLowerCase().split(/\s+/)) {
      if (word.length > 1) out.add(word)
    }
  }
  return out
})()

/**
 * Are these two rows the SAME PROGRAM?
 *
 * NOT the same program (asserted in the tests): "Tennessee HOPE Scholarship" vs
 * "Tennessee Promise Scholarship" — neither token set contains the other.
 */
export function sameProgram(a, b, { canonicalKeyIsFinal = true } = {}) {
  const keyA = programIdentityKey(a)
  const keyB = programIdentityKey(b)
  if (keyA === keyB) return true
  // A canonical key is an EXPLICIT identity claim; disagreement there is final.
  //
  // MEASURED 2026-08-25, and the reason this is now an OPTION: every catalog row
  // carries `canonical_opportunity_key`, so on real data BOTH sides return a
  // `c:` key and this line returns false before containment is ever tested —
  // i.e. the whole subset branch below is unreachable for catalog rows, and only
  // fixtures that omit the column ever exercised it. Live example, one profile:
  //   "Katie Beckett Waiver"  c:t:tenncare::beckett katie waiver
  //   "Katie Beckett Program" c:t:tenncare::beckett katie program
  // One program, two keys, both shown.
  //
  // The default stays TRUE because for a PIPELINE row the key is a claim about
  // the RECORD and disagreement really is final. The owner-facing DISPLAY asks a
  // different question — "are these one program to someone reading a list?" —
  // and passes false. Callers that opt out must supply their own corroboration
  // (the display path requires the sponsors to agree); do not flip this default.
  if (canonicalKeyIsFinal && keyA.startsWith('c:') && keyB.startsWith('c:')) return false

  const ta = programTokens(a)
  const tb = programTokens(b)
  if (ta.length === 0 || tb.length === 0) return false
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const largeSet = new Set(large)
  if (!small.every((t) => largeSet.has(t))) return false
  // Containment alone is not identity when the shared core is ONE short word.
  // Two independent escapes, and a pair needs only one:
  //   (a) the lone token is long enough to be a program NAME ("questbridge"),
  //   (b) every extra word in the longer title is a QUALIFIER — a place, an
  //       institution, a scope — so the longer title is the same program with
  //       its jurisdiction spelled out ("Tennessee HOPE Scholarship").
  if (small.length === 1 && small[0].length < MIN_LONE_TOKEN_IDENTITY_LENGTH) {
    const extras = large.filter((t) => !small.includes(t))
    if (!extras.every((t) => QUALIFIER_TOKENS.has(t))) return false
  }
  return true
}

/** Sponsor words that carry no funder identity on their own. */
const SPONSOR_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'at', 'in', 'to', 'on',
  'inc', 'llc', 'corp', 'co', 'org', 'organization', 'organizations',
])

function sponsorTokens(row) {
  return new Set(
    String(row?.sponsor || row?.funder || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !SPONSOR_STOPWORDS.has(t)),
  )
}

/**
 * Do two rows' funders AGREE — i.e. is there no positive evidence they are
 * different organizations?
 *
 * Required by any caller that opts out of canonical-key finality. `sameProgram`
 * deliberately ignores the funder (the owner's duplicate examples pair one
 * program with two funder SPELLINGS), which is safe while an explicit key can
 * still veto — but a caller that removes the veto needs some corroboration back,
 * or unrelated programs that happen to share a generic name merge.
 *
 * MEASURED on one live profile: three rows titled exactly "Family Support
 * Program" are sponsored by Tennessee State Government, the TN Department of
 * Aging & Disability, and the City of Chattanooga. Those may well be three real
 * programs, so they must NOT collapse — while "…Intellectual and Developmental
 * Disabilities" vs "…Intellectual and Developmental Disabilities (DIDD)" is one
 * funder spelled two ways and must.
 *
 * The rule is SUBSET, not shared-token: sharing one word ("tennessee") is the
 * one-shared-word floor this codebase has been burned by repeatedly. A blank
 * sponsor is SILENCE and agrees with anything — silence is not a denial.
 */
export function sponsorsAgree(a, b) {
  const ta = sponsorTokens(a)
  const tb = sponsorTokens(b)
  if (ta.size === 0 || tb.size === 0) return true
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  for (const token of small) if (!large.has(token)) return false
  return true
}

export default {
  IDENTITY_STOPWORDS,
  sponsorsAgree,
  stripProgramQualifiers,
  programTokens,
  programIdentityKey,
  MIN_LONE_TOKEN_IDENTITY_LENGTH,
  QUALIFIER_TOKENS,
  sameProgram,
}
