/**
 * Entity Resolution Foundation
 *
 * Purpose:
 * - Provide deterministic, privacy-aware matching for business / nonprofit / federal entities
 * - Prefer authoritative keys before falling back to tuple and fuzzy matching
 * - Return auditable match decisions with confidence and review guidance
 *
 * This module is intentionally self-contained so it can be wired into crawlers,
 * admin tools, or matching routes without adding third-party dependencies.
 */

const IRS_AUTHORITATIVE_SOURCES = new Set([
  'irs',
  'irs_eo_bmf',
  'irs eo bmf',
  'irs-bmf',
  'eo_bmf',
])

const AUTO_MERGE_THRESHOLD = 0.93
const REVIEW_THRESHOLD = 0.85

export function resolveEntityMatch(existing, incoming) {
  const left = normalizeEntity(existing)
  const right = normalizeEntity(incoming)

  if (!left || !right) {
    return buildNoMatch('Invalid entity payload')
  }

  if (left.uei && right.uei && left.uei === right.uei) {
    return buildMatch({
      method: 'direct_key',
      confidence: 1,
      reviewRequired: false,
      reasons: ['UEI exact match'],
      existing: left.original,
      incoming: right.original,
    })
  }

  if (
    left.ein &&
    right.ein &&
    left.ein === right.ein &&
    isAuthoritativeEinSource(left.einSource) &&
    isAuthoritativeEinSource(right.einSource)
  ) {
    return buildMatch({
      method: 'direct_key',
      confidence: 1,
      reviewRequired: false,
      reasons: ['EIN exact match from authoritative IRS-style sources'],
      existing: left.original,
      incoming: right.original,
    })
  }

  if (left.ein && right.ein && left.ein === right.ein) {
    return buildNoMatch('Matching EIN ignored because one or both sources are not authoritative')
  }

  if (
    left.stateEntityNumber &&
    right.stateEntityNumber &&
    left.stateJurisdiction &&
    right.stateJurisdiction &&
    left.stateEntityNumber === right.stateEntityNumber &&
    left.stateJurisdiction === right.stateJurisdiction
  ) {
    return buildMatch({
      method: 'direct_key',
      confidence: 0.98,
      reviewRequired: false,
      reasons: ['State entity number exact match within same jurisdiction'],
      existing: left.original,
      incoming: right.original,
    })
  }

  if (left.normalizedName && right.normalizedName && left.normalizedAddress && right.normalizedAddress) {
    if (left.normalizedName === right.normalizedName && left.normalizedAddress === right.normalizedAddress) {
      return buildMatch({
        method: 'exact_tuple',
        confidence: 0.95,
        reviewRequired: false,
        reasons: ['Exact normalized legal name + address tuple match'],
        existing: left.original,
        incoming: right.original,
      })
    }
  }

  const nameScore = diceCoefficient(left.normalizedName, right.normalizedName)
  const addressScore = diceCoefficient(left.normalizedAddress, right.normalizedAddress)
  const cageScore = left.cage && right.cage && left.cage === right.cage ? 1 : 0
  const naicsScore = overlapScore(left.naics, right.naics)

  const weightedScore = roundScore(
    (nameScore * 0.55) +
    (addressScore * 0.25) +
    (cageScore * 0.10) +
    (naicsScore * 0.10),
  )

  if (weightedScore >= REVIEW_THRESHOLD) {
    const reasons = []
    if (nameScore > 0.9) reasons.push(`Strong legal-name similarity (${nameScore})`)
    if (addressScore > 0.85) reasons.push(`Strong address similarity (${addressScore})`)
    if (cageScore === 1) reasons.push('CAGE exact match')
    if (naicsScore > 0) reasons.push(`NAICS overlap (${naicsScore})`)

    return buildMatch({
      method: 'fuzzy',
      confidence: weightedScore,
      reviewRequired: weightedScore < AUTO_MERGE_THRESHOLD,
      reasons,
      existing: left.original,
      incoming: right.original,
    })
  }

  return buildNoMatch('No authoritative, tuple, or fuzzy threshold match found')
}

export function normalizeEntity(entity = {}) {
  const address = getPrimaryAddress(entity)
  const source = String(entity.source || entity.source_name || entity.publisher || '').trim().toLowerCase()

  return {
    original: entity,
    entityId: entity.entity_id ?? entity.id ?? null,
    uei: normalizeUei(entity.uei),
    ein: normalizeEin(entity.ein),
    einSource: source,
    stateEntityNumber: normalizeLooseIdentifier(entity.state_entity_number || entity.stateEntityNumber),
    stateJurisdiction: normalizeJurisdiction(entity.state_jurisdiction || entity.stateJurisdiction),
    legalName: String(entity.legal_name || entity.legalName || entity.name || '').trim(),
    normalizedName: normalizeLegalName(entity.legal_name || entity.legalName || entity.name || ''),
    normalizedAddress: normalizeAddress(address),
    cage: normalizeLooseIdentifier(entity.cage),
    naics: normalizeNaicsList(entity.naics),
  }
}

export function normalizeLegalName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|inc|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|pllc|pc|p\.c\.)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeAddress(address = {}) {
  const line1 = String(address.line1 || address.address1 || address.street || '').toLowerCase()
  const city = String(address.city || '').toLowerCase()
  const state = normalizeJurisdiction(address.state || address.region || '')
  const zip = String(address.zip || address.postal_code || address.postalCode || '')
    .replace(/[^0-9a-z]/gi, '')
    .toLowerCase()

  return [line1, city, state, zip]
    .map((part) => String(part || '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ')
}

export function diceCoefficient(a, b) {
  const left = String(a || '').trim()
  const right = String(b || '').trim()

  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0

  const leftBigrams = bigramCounts(left)
  const rightBigrams = bigramCounts(right)

  let overlap = 0
  for (const [token, count] of leftBigrams.entries()) {
    if (!rightBigrams.has(token)) continue
    overlap += Math.min(count, rightBigrams.get(token))
  }

  return roundScore((2 * overlap) / (countMapTotal(leftBigrams) + countMapTotal(rightBigrams)))
}

function bigramCounts(value) {
  const counts = new Map()
  for (let index = 0; index < value.length - 1; index += 1) {
    const token = value.slice(index, index + 2)
    counts.set(token, (counts.get(token) || 0) + 1)
  }
  return counts
}

function countMapTotal(map) {
  let total = 0
  for (const value of map.values()) total += value
  return total
}

function overlapScore(left = [], right = []) {
  const leftSet = new Set((left || []).filter(Boolean))
  const rightSet = new Set((right || []).filter(Boolean))
  if (leftSet.size === 0 || rightSet.size === 0) return 0

  let intersection = 0
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1
  }

  const union = new Set([...leftSet, ...rightSet]).size
  if (!union) return 0
  return roundScore(intersection / union)
}

function normalizeUei(value) {
  const normalized = normalizeLooseIdentifier(value)
  if (!normalized) return null
  return normalized.length === 12 ? normalized : normalized
}

function normalizeEin(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits.length === 9 ? digits : null
}

function normalizeLooseIdentifier(value) {
  const normalized = String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase().trim()
  return normalized || null
}

function normalizeJurisdiction(value) {
  return String(value || '').toLowerCase().replace(/[^a-z]/g, '').trim() || null
}

function normalizeNaicsList(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : String(value).split(/[;,|]/)
  return list
    .map((item) => String(item || '').replace(/\D/g, ''))
    .filter(Boolean)
}

function getPrimaryAddress(entity) {
  return entity.address || {
    line1: entity.address_line1 || entity.street || entity.line1,
    city: entity.city,
    state: entity.state,
    zip: entity.zip || entity.postal_code,
  }
}

function isAuthoritativeEinSource(value) {
  return IRS_AUTHORITATIVE_SOURCES.has(String(value || '').trim().toLowerCase())
}

function buildMatch({ method, confidence, reviewRequired, reasons, existing, incoming }) {
  return {
    matched: true,
    method,
    confidence: roundScore(confidence),
    reviewRequired: Boolean(reviewRequired),
    autoMergeEligible: Number(confidence) >= AUTO_MERGE_THRESHOLD,
    reasons: Array.isArray(reasons) ? reasons.filter(Boolean) : [],
    existingEntityId: existing?.entity_id ?? existing?.id ?? null,
    incomingEntityId: incoming?.entity_id ?? incoming?.id ?? null,
    occurredAt: new Date().toISOString(),
  }
}

function buildNoMatch(reason) {
  return {
    matched: false,
    method: null,
    confidence: 0,
    reviewRequired: false,
    autoMergeEligible: false,
    reasons: reason ? [reason] : [],
    existingEntityId: null,
    incomingEntityId: null,
    occurredAt: new Date().toISOString(),
  }
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 1000) / 1000
}

export default {
  resolveEntityMatch,
  normalizeEntity,
  normalizeLegalName,
  normalizeAddress,
  diceCoefficient,
}
