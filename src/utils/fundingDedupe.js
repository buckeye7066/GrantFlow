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

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
])

function normalizeText(value) {
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

function tokenizeTitle(title) {
  return normalizeText(title)
    .split(' ')
    .map(normalizeToken)
    .filter(Boolean)
}

function coreTitleTokens(title) {
  return tokenizeTitle(title).filter((token) => !GENERIC_TITLE_TOKENS.has(token))
}

function numericTitleTokens(title) {
  return normalizeText(title)
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

function firstAcronymAnchor(title) {
  const rawTokens = String(title ?? '').match(/[A-Za-z][A-Za-z0-9-]*/g) || []
  for (const raw of rawTokens) {
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, '')
    if (cleaned.length >= 3 && cleaned.length <= 12 && /[A-Za-z]/.test(cleaned) && cleaned === cleaned.toUpperCase()) {
      return normalizeToken(cleaned.toLowerCase())
    }
    break
  }
  return ''
}

function fundingKind(result = {}) {
  const explicit = normalizeText(result.kind || result.opportunity_kind || result.opportunity_type || result.type)
  const text = normalizeText(`${result.title ?? ''} ${result.description ?? ''}`)
  const tokens = new Set(text.split(' ').map(normalizeToken).filter(Boolean))
  if (explicit.includes('scholarship') || text.includes('scholarship')) return 'scholarship'
  if (explicit.includes('grant') || tokens.has('grant')) return 'grant'
  if (explicit.includes('award') || tokens.has('award')) return 'award'
  if (explicit.includes('benefit') || explicit.includes('assistance') || tokens.has('assistance')) return 'benefit'
  return explicit || ''
}

function sponsorKey(result = {}) {
  return normalizeText(result.sponsor || result.funder || result.organization || result.agency)
}

function titleFunderKey(result = {}) {
  const title = normalizeText(result.title || result.program_name || result.name)
  const funder = sponsorKey(result)
  return title && funder ? `${title}|${funder}` : ''
}

function strongIdentityKeys(result = {}) {
  const source = normalizeText(result.source || result.crawler_type || result.record_origin || 'catalog')
  return [
    result.canonical_opportunity_key ? `canonical:${String(result.canonical_opportunity_key).trim().toLowerCase()}` : '',
    result.fingerprint ? `fingerprint:${String(result.fingerprint).trim().toLowerCase()}` : '',
    result.funding_opportunity_id ? `funding:${String(result.funding_opportunity_id).trim().toLowerCase()}` : '',
    result.opportunity_id ? `opportunity:${String(result.opportunity_id).trim().toLowerCase()}` : '',
    result.id ? `id:${source}:${String(result.id).trim().toLowerCase()}` : '',
  ].filter(Boolean)
}

export function normalizeFundingUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw || !/^https?:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
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

function resultUrlKey(result = {}) {
  return normalizeFundingUrl(
    result.application_url ||
      result.applicationUrl ||
      result.url ||
      result.source_url ||
      result.sourceUrl ||
      result.portal_url ||
      result.portalUrl ||
      result.funder_website,
  )
}

function sourceIdKey(result = {}) {
  const source = normalizeText(result.source || result.crawler_type || result.record_origin)
  const sourceId = normalizeText(result.source_id || result.external_id || result.opportunity_id)
  return source && sourceId ? `${source}|${sourceId}` : ''
}

function familyCandidate(result = {}) {
  const title = result.title || result.program_name || result.name || ''
  const funder = sponsorKey(result)
  const anchor = firstAcronymAnchor(title)
  const kind = fundingKind(result)
  if (!funder || !anchor || !kind) return null
  return {
    funder,
    anchor,
    kind,
    tokens: coreTitleTokens(title),
    descriptionTokens: coreTitleTokens(result.description || result.descriptionMd || result.summary || ''),
  }
}

function sameFamily(a = {}, b = {}) {
  const left = familyCandidate(a)
  const right = familyCandidate(b)
  if (!left || !right) return false
  if (left.funder !== right.funder || left.anchor !== right.anchor || left.kind !== right.kind) return false
  const titleScore = tokenSimilarity(left.tokens, right.tokens)
  const descScore = tokenSimilarity(left.descriptionTokens, right.descriptionTokens)
  const oneTitleIsFamilyUmbrella = Math.min(left.tokens.length, right.tokens.length) <= 1
  const scholarshipUmbrella =
    left.kind === 'scholarship' &&
    oneTitleIsFamilyUmbrella &&
    Math.max(left.tokens.length, right.tokens.length) >= 3
  return titleScore >= 0.55 || descScore >= 0.38 || (oneTitleIsFamilyUmbrella && descScore >= 0.28) || scholarshipUmbrella
}

function compatibleSharedUrlIdentity(a = {}, b = {}) {
  const aTitle = normalizeText(a.title || a.program_name || a.name)
  const bTitle = normalizeText(b.title || b.program_name || b.name)
  if (!aTitle || !bTitle || aTitle === bTitle) return true
  if (hasConflictingNumericTitleTokens(aTitle, bTitle)) return false
  const titleScore = tokenSimilarity(
    coreTitleTokens(a.title || a.program_name || a.name || ''),
    coreTitleTokens(b.title || b.program_name || b.name || ''),
  )
  return titleScore >= 0.55 || sameFamily(a, b)
}

export function areDuplicateFundingResults(a = {}, b = {}) {
  const aStrong = strongIdentityKeys(a)
  if (aStrong.length > 0) {
    const bStrong = new Set(strongIdentityKeys(b))
    if (aStrong.some((key) => bStrong.has(key))) return true
  }

  const aUrl = resultUrlKey(a)
  const bUrl = resultUrlKey(b)
  if (aUrl && bUrl && aUrl === bUrl) return compatibleSharedUrlIdentity(a, b)

  const aSource = sourceIdKey(a)
  const bSource = sourceIdKey(b)
  if (aSource && bSource && aSource === bSource) return true

  const aTitleFunder = titleFunderKey(a)
  const bTitleFunder = titleFunderKey(b)
  if (aTitleFunder && bTitleFunder && aTitleFunder === bTitleFunder) return true

  return sameFamily(a, b)
}

function scoreOf(result = {}) {
  const n = Number(result.match_score ?? result.match ?? result.score ?? 0)
  return Number.isFinite(n) ? n : 0
}

function hasApplyLink(result = {}) {
  return Boolean(resultUrlKey({ application_url: result.application_url || result.applicationUrl || result.url }))
}

function textRichness(result = {}) {
  return String(result.description || result.descriptionMd || result.summary || '').length
}

function preferResult(a = {}, b = {}) {
  const scoreDelta = scoreOf(b) - scoreOf(a)
  if (scoreDelta !== 0) return scoreDelta > 0 ? b : a
  if (hasApplyLink(a) !== hasApplyLink(b)) return hasApplyLink(b) ? b : a
  return textRichness(b) > textRichness(a) ? b : a
}

function mergeResults(existing, incoming) {
  const winner = preferResult(existing, incoming)
  const loser = winner === existing ? incoming : existing
  return {
    ...loser,
    ...winner,
    match_reasons: winner.match_reasons ?? loser.match_reasons,
    matchReasons: winner.matchReasons ?? loser.matchReasons,
    matched_fields: winner.matched_fields ?? loser.matched_fields,
    application_url: winner.application_url ?? loser.application_url,
    url: winner.url ?? loser.url,
    source_url: winner.source_url ?? loser.source_url,
  }
}

export function dedupeFundingResults(results = []) {
  if (!Array.isArray(results) || results.length === 0) return []
  const unique = []
  for (const result of results) {
    if (!result || typeof result !== 'object') continue
    const index = unique.findIndex((existing) => areDuplicateFundingResults(existing, result))
    if (index === -1) {
      unique.push(result)
    } else {
      unique[index] = mergeResults(unique[index], result)
    }
  }
  return unique
}
