/**
 * countyDeclaration.js — a row that names ITSELF after a county is a
 * single-county award, and it qualifies only for a profile that lives there.
 *
 * Owner rule 2026-09-07: "franklin county should not qualify, he does not live
 * in franklin county." The engine already recognised the "<Name> County
 * <award>" shape (matchEngine.titleNamesLocalDistrict) but only DOWNGRADED it
 * when the row resolved to another STATE; in-state, or with no state at all
 * (the common case: state column NULL), a different county sailed through.
 *
 * The shape is structural, so it works for any US county with no county→state
 * table: "<Name> County" in the row's IDENTITY fields (title + sponsor/funder —
 * never description prose, #1086) AND an award noun AND not a county SERVICE
 * agency ("Bradley County Community Action Agency" is a safety net, not a
 * restricted award). MISSING = NEUTRAL on both sides: a row naming no county,
 * or a profile with no corroborated county anchor, decides nothing.
 */
import { normalizeTerm } from './profileDerivedFacts.js'
import { normalizeCountyName } from './crisisNeedRecall.js'

const COUNTY_DECLARATION_RX = /\b((?:[A-Za-z][A-Za-z.'-]+\s+){1,2}?)(county|parish|borough)\b/gi
const LOCAL_AWARD_NOUN_RX = /\b(scholarships?|grants?|awards?|fund|foundation)\b/i
const COUNTY_SERVICE_AGENCY_RX =
  /\b(community action|action agency|health department|department of|human services|social services|sheriff|clerk|trustee|commission|county government|library|food bank|housing authority|extension office|schools?|school district)\b/i
/** Words that precede "County" without being part of its name. */
const NOT_A_COUNTY_WORD = new Set(['the', 'of', 'in', 'for', 'and', 'a', 'an', 'to', 'at', 'from', 'your', 'our', 'every', 'each', 'any', 'all', 'this', 'that', 'local', 'rural', 'urban'])

function identityText(row) {
  return [row?.title, row?.sponsor, row?.funder, row?.funder_name]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' | ')
}

/** Canonical comparison key for a county name: "La Grange" and "LaGrange" are one county. */
export function countyKey(name) {
  return normalizeTerm(normalizeCountyName(name)).replace(/\s+/g, '')
}

/**
 * The counties a row DECLARES as its own single-county award scope, from its
 * identity fields only. Empty when the row is not a county-named award.
 * @returns {string[]} display names, e.g. ['Franklin']
 */
export function declaredAwardCounties(row) {
  const text = identityText(row)
  if (!text) return []
  if (!LOCAL_AWARD_NOUN_RX.test(text)) return []
  if (COUNTY_SERVICE_AGENCY_RX.test(text)) return []
  const found = []
  for (const m of text.matchAll(COUNTY_DECLARATION_RX)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !NOT_A_COUNTY_WORD.has(w.toLowerCase()))
    if (words.length === 0) continue
    const name = words.join(' ')
    if (!found.some((f) => countyKey(f) === countyKey(name))) found.push(name)
  }
  return found
}

/**
 * Does this county-named award belong to somewhere other than the profile's
 * county? `profileCounty` is the profile's CORROBORATED anchor
 * (crisisNeedRecall.resolveProfileCountyAnchor) — declared county, or a ZIP
 * county confirmed by the declared city. Null anchor → neutral.
 * @returns {{ mismatch: boolean, declared: string[], profile: string|null }}
 */
export function countyAwardMismatch(row, profileCounty) {
  const declared = declaredAwardCounties(row)
  const profileKey = countyKey(profileCounty)
  if (declared.length === 0 || !profileKey) return { mismatch: false, declared, profile: profileCounty ?? null }
  const names = declared.some((d) => countyKey(d) === profileKey)
  return { mismatch: !names, declared, profile: profileCounty }
}

export default { declaredAwardCounties, countyAwardMismatch, countyKey }
