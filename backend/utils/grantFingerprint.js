/**
 * Canonical grant fingerprint.
 *
 * Produces a stable sha256 hex over the identity tuple used by the grants
 * pipeline to dedup rows across crawls and across dialects. This is the
 * SAME tuple used by migration 058/0051 to backfill historical rows, so
 * new inserts from matchEngine / applyEngine / routes/grants align with
 * the backfill and dedup works from day one.
 *
 * Identity tuple: (title | funder | deadline | source-like url).
 * Each field is normalized to a trimmed lowercase string with internal
 * whitespace collapsed so trivial formatting differences don't break
 * dedup.
 *
 * Usage:
 *   import { grantFingerprint, GRANT_FINGERPRINT_VERSION } from '.../grantFingerprint.js'
 *   const fp = grantFingerprint({ title, funder, deadline, url })
 */

import crypto from 'crypto'

export const GRANT_FINGERPRINT_VERSION = 1

function norm(v) {
  if (v === null || v === undefined) return ''
  const s = String(v).trim().toLowerCase()
  return s.replace(/\s+/g, ' ')
}

const GENERIC_TITLE_TOKENS = new Set([
  'a',
  'an',
  'and',
  'apply',
  'application',
  'applications',
  'assistance',
  'award',
  'awards',
  'benefit',
  'benefits',
  'education',
  'educational',
  'financial',
  'for',
  'fund',
  'funding',
  'grant',
  'grants',
  'in',
  'of',
  'opportunity',
  'opportunities',
  'program',
  'programs',
  'scholarship',
  'scholarships',
  'the',
  'to',
])

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid'])

function normalizeSearchText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeToken(token) {
  if (!token) return ''
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  return token
}

function coreTitleTokens(title) {
  return normalizeSearchText(title)
    .split(' ')
    .map(normalizeToken)
    .filter((token) => token && !GENERIC_TITLE_TOKENS.has(token))
}

function numericTitleTokens(title) {
  return normalizeSearchText(title)
    .split(' ')
    .filter((token) => /^\d+$/.test(token))
}

function hasConflictingNumericTitleTokens(aTitle, bTitle) {
  const aNums = new Set(numericTitleTokens(aTitle))
  const bNums = new Set(numericTitleTokens(bTitle))
  if (aNums.size === 0 || bNums.size === 0) return false
  for (const value of aNums) {
    if (bNums.has(value)) return false
  }
  return true
}

function tokenSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens)
  const b = new Set(bTokens)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  a.forEach((token) => {
    if (b.has(token)) overlap += 1
  })
  return overlap / Math.max(a.size, b.size)
}

/**
 * The FIRST token of the title that is an acronym — not "the first token, if it
 * happens to be an acronym".
 *
 * TRAP THIS FIXES (2026-08-14): the loop carried an UNCONDITIONAL `break` at the
 * end of its body, so it ran exactly one iteration and only ever inspected
 * `rawTokens[0]`. Any title with a leading article or adjective ("The AFTE
 * Forensic Science Scholarship", "New NAEMT Paramedic Scholarship") therefore
 * resolved to an EMPTY anchor here, `grantFamilyKey` returned null, and
 * `likelySameGrantOpportunity` fell straight out at the `!sameFamily` guard.
 *
 * The identical function in `src/utils/fundingDedupe.js` has no `break` and DOES
 * scan every token, so the two copies of one identity rule disagreed: the same
 * pair of rows collapsed in the discovery UI while the backend catalog, the
 * pipeline-exclusion index and the boot invariant sweeps kept them as two
 * separate opportunities. Aligning on the scanning form makes catalog dedup
 * (criterion 4) agree with what the user is already shown.
 *
 * Widening the anchor is only safe because the numeric-conflict guard now also
 * covers the family branch of `likelySameGrantOpportunity` — see below.
 */
function firstAcronymAnchor(title) {
  const rawTokens = String(title ?? '').match(/[A-Za-z][A-Za-z0-9-]*/g) || []
  for (const raw of rawTokens) {
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, '')
    if (cleaned.length >= 3 && cleaned.length <= 12 && /[A-Za-z]/.test(cleaned) && cleaned === cleaned.toUpperCase()) {
      return normalizeToken(cleaned.toLowerCase())
    }
  }
  return ''
}

function opportunityFunder(opportunity = {}) {
  return normalizeSearchText(opportunity.sponsor || opportunity.funder || opportunity.organization || opportunity.agency)
}

function fundingKind(opportunity = {}) {
  const explicit = normalizeSearchText(opportunity.kind || opportunity.opportunity_kind || opportunity.opportunity_type || opportunity.type)
  const text = normalizeSearchText(`${opportunity.title ?? ''} ${opportunity.description ?? ''} ${opportunity.descriptionMd ?? ''}`)
  const tokens = new Set(text.split(' ').map(normalizeToken).filter(Boolean))
  if (explicit.includes('scholarship') || text.includes('scholarship')) return 'scholarship'
  if (explicit.includes('grant') || tokens.has('grant')) return 'grant'
  if (explicit.includes('award') || tokens.has('award')) return 'award'
  if (explicit.includes('benefit') || explicit.includes('assistance') || tokens.has('assistance')) return 'benefit'
  return explicit || ''
}

export function chooseGrantUrl(opportunity = {}) {
  const candidates = [
    opportunity.url,
    opportunity.application_url,
    opportunity.applicationUrl,
    opportunity.source_url,
    opportunity.sourceUrl,
    opportunity.portal_url,
    opportunity.portalUrl,
    opportunity.funder_website,
  ]
  for (const u of candidates) {
    if (u && typeof u === 'string') {
      const trimmed = u.trim()
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    }
  }
  return null
}

export function normalizeGrantUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw || !/^https?:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase()
      if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
        url.searchParams.delete(key)
      }
    }
    const params = Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b))
    url.search = ''
    for (const [key, val] of params) url.searchParams.append(key, val)
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().toLowerCase()
  } catch {
    return ''
  }
}

export function grantUrlKey(opportunity = {}) {
  return normalizeGrantUrl(chooseGrantUrl(opportunity))
}

export function grantFamilyKey(opportunity = {}) {
  const title = opportunity.title || opportunity.program_name || opportunity.name || ''
  const funder = opportunityFunder(opportunity)
  const anchor = firstAcronymAnchor(title)
  const kind = fundingKind(opportunity)
  if (!title || !funder || !anchor || !kind) return null
  return `${funder}|${anchor}|${kind}`
}

export function likelySameGrantOpportunity(a = {}, b = {}) {
  const aUrl = grantUrlKey(a)
  const bUrl = grantUrlKey(b)
  const aFamily = grantFamilyKey(a)
  const bFamily = grantFamilyKey(b)
  const aTokens = coreTitleTokens(a.title || a.program_name || a.name || '')
  const bTokens = coreTitleTokens(b.title || b.program_name || b.name || '')
  const titleScore = tokenSimilarity(aTokens, bTokens)
  const oneTitleIsFamilyUmbrella = Math.min(aTokens.length, bTokens.length) <= 1
  const aDescTokens = coreTitleTokens(a.description || a.descriptionMd || a.summary || '')
  const bDescTokens = coreTitleTokens(b.description || b.descriptionMd || b.summary || '')
  const descScore = tokenSimilarity(aDescTokens, bDescTokens)
  const sameFamily = Boolean(aFamily && bFamily && aFamily === bFamily)
  const familyKind = String(aFamily).split('|').pop()
  const scholarshipUmbrella =
    sameFamily &&
    familyKind === 'scholarship' &&
    oneTitleIsFamilyUmbrella &&
    Math.max(aTokens.length, bTokens.length) >= 3

  if (aUrl && bUrl && aUrl === bUrl) {
    const aTitle = normalizeSearchText(a.title || a.program_name || a.name || '')
    const bTitle = normalizeSearchText(b.title || b.program_name || b.name || '')
    if (!aTitle || !bTitle || aTitle === bTitle) return true
    if (hasConflictingNumericTitleTokens(aTitle, bTitle)) return false
    return titleScore >= 0.55 || (
      sameFamily &&
      (descScore >= 0.38 || (oneTitleIsFamilyUmbrella && descScore >= 0.28) || scholarshipUmbrella)
    )
  }

  if (!sameFamily) return false

  // A DIFFERENT NUMBER IN THE TITLE IS A DIFFERENT PROGRAM — on this branch too.
  //
  // The same-URL branch above has consulted `hasConflictingNumericTitleTokens`
  // since the "numbered awards on one landing page" fix, but the FAMILY branch
  // never did — and this is the branch reached when the two rows' URLs DIFFER or
  // are missing, i.e. precisely the case where they are most likely to be two
  // distinct real-world programs. Same funder + same acronym anchor + same kind
  // + boilerplate-similar descriptions was enough to collapse "…Grant 2025" into
  // "…Grant 2026", or mechanism 1 into mechanism 2, and the losing row then
  // disappears from the catalog and the pipeline entirely.
  //
  // Titles with no numerals are unaffected (the helper returns false when either
  // side has no numeric token), so every existing family collapse still holds.
  const aTitleText = normalizeSearchText(a.title || a.program_name || a.name || '')
  const bTitleText = normalizeSearchText(b.title || b.program_name || b.name || '')
  if (hasConflictingNumericTitleTokens(aTitleText, bTitleText)) return false

  return (
    titleScore >= 0.55 ||
    descScore >= 0.38 ||
    (oneTitleIsFamilyUmbrella && descScore >= 0.28) ||
    scholarshipUmbrella
  )
}

export function grantFingerprint({ title, funder, deadline, url } = {}) {
  const tuple = [norm(title), norm(funder), norm(deadline), norm(url)].join('|')
  return crypto.createHash('sha256').update(tuple, 'utf8').digest('hex')
}

/**
 * Convenience: pull the identity tuple from an opportunity-shaped object
 * (what matchEngine / crawlers pass around) so call sites don't have to
 * remember which fields to feed in.
 */
export function grantFingerprintFromOpportunity(opportunity = {}) {
  return grantFingerprint({
    title: opportunity.title,
    funder: opportunity.sponsor || opportunity.funder,
    deadline: opportunity.deadline,
    url: chooseGrantUrl(opportunity),
  })
}
