import { correctedCanonicalUsScope } from '../../config/canonicalUsJurisdiction.js'

const ARTICLE_PATH_RX = /(?:^|[/?#&._-])(?:blog|news|article|story|opinion|press-release|insights|knowledge|guide|how-to|tips|basics)(?:[/?#&._-]|$)/i
const NON_GRANT_TYPES = new Set(['directory', 'program', 'benefit', 'referral'])
const QUERY_TEMPLATE_PARAMS = new Set(['zip', 'zipcode', 'postal', 'postal_code', 'state'])

function pickUrl(record) {
  return record?.application_url ?? record?.apply_url ?? record?.url ?? record?.source_url ?? record?.evidence_url ?? null
}

function parseUrl(record) {
  const raw = pickUrl(record)
  if (!raw || typeof raw !== 'string') return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function hasApplicationPageTag(record) {
  const fields = [
    record?.page_type,
    record?.pageType,
    record?.url_type,
    record?.urlType,
    record?.source_category,
    record?.application_mode,
    record?.funding_source_type,
  ]
  if (record?.is_application_page === true || record?.application_page === true) return true
  return fields.some((value) => /\b(apply|application|portal)\b/i.test(String(value || '')))
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function inferOpportunityDisplayType(record) {
  const values = [
    record?.opportunity_type,
    record?.funding_type,
    record?.source_category,
    record?.type,
  ].map(lower)

  if (values.some((value) => value === 'directory' || value === 'directory_resource')) return 'directory'
  if (values.some((value) => value === 'benefit' || value === 'direct_benefit')) return 'benefit'
  if (values.some((value) => value === 'program' || value === 'direct_service')) return 'program'
  if (values.some((value) => value === 'referral' || value === 'referral_lookup')) return 'referral'
  return lower(record?.opportunity_type) || lower(record?.funding_type) || 'grant'
}

export function getReferralTemplateKey(record) {
  const url = parseUrl(record)
  if (!url) return null
  const hasTemplateParam = Array.from(url.searchParams.keys()).some((key) =>
    QUERY_TEMPLATE_PARAMS.has(lower(key)),
  )
  if (!hasTemplateParam) return null
  if (hasApplicationPageTag(record)) return null
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}`
}

export function stripReferralQuery(record) {
  const url = parseUrl(record)
  if (!url) return pickUrl(record)
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function evaluateFundableOpportunity(record) {
  const url = parseUrl(record)
  if (url && ARTICLE_PATH_RX.test(url.pathname) && !hasApplicationPageTag(record)) {
    return { ok: false, reason: 'article_or_informational_url' }
  }

  const displayType = inferOpportunityDisplayType(record)
  const normalized = {}

  // Canonical U.S. funder/institution jurisdiction outranks a state copied from
  // search/profile context. This is the ingest choke point used by
  // opportunityInserter, so new CPCC/Ohio-RDA rows cannot be persisted as TN.
  const canonicalScope = correctedCanonicalUsScope(record)
  if (canonicalScope) Object.assign(normalized, canonicalScope)

  if (NON_GRANT_TYPES.has(displayType)) {
    normalized.opportunity_type = displayType
    normalized.type = displayType === 'directory' || displayType === 'referral' ? 'DIRECTORY' : 'PROGRAM'
  }

  const referralKey = getReferralTemplateKey(record)
  if (referralKey) {
    normalized.opportunity_type = 'referral'
    normalized.type = 'DIRECTORY'
    normalized.application_url = stripReferralQuery(record)
    normalized.source_url = stripReferralQuery({ url: record?.source_url ?? record?.application_url ?? record?.url })
    return {
      ok: true,
      reason: null,
      kind: 'referral_template',
      displayType: 'referral',
      referralKey,
      normalized,
    }
  }

  return {
    ok: true,
    reason: null,
    kind: 'fundable',
    displayType,
    referralKey: null,
    normalized,
  }
}

export function isFundableOpportunity(record) {
  return evaluateFundableOpportunity(record).ok
}

export function applyFundableOpportunityNormalization(record, evaluation = evaluateFundableOpportunity(record)) {
  if (!evaluation?.ok) return record
  return { ...record, ...(evaluation.normalized || {}) }
}
