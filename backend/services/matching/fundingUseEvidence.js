/** Source-owned funding-use evidence. No profile prose, scoring, I/O or inferred eligibility. */
const TEXT_FIELDS = Object.freeze(['description', 'eligibility', 'eligibility_text', 'eligibility_criteria', 'requirements', 'funding_restrictions'])
const COST_RULES = Object.freeze([
  { request: /\b(?:supplies|consumables|reagents|materials)\b/, terms: ['supplies', 'consumables', 'reagents', 'materials'] },
  { request: /\b(?:equipment|instruments)\b/, terms: ['equipment', 'instruments'] },
  { request: /\b(?:salaries|salary|wages|personnel|payroll)\b/, terms: ['salaries', 'salary', 'wages', 'personnel costs', 'payroll'] },
  { request: /\b(?:rent|rental|lease)\b/, terms: ['rent', 'rental costs', 'leasing costs'] },
  { request: /\b(?:building|buildings|construction|real property)\b/, terms: ['building acquisition', 'building purchase', 'construction', 'buildings', 'building'], capital: true },
])
const GENERIC_PREFIXES = new Set(['', '|', 'and', 'or', 'include', 'includes', 'including', 'for', 'on', 'cover', 'covers', 'support', 'supports', 'fund', 'funds', 'pay', 'paying', 'purchase', 'purchases', 'purchasing', 'of', 'as', 'costs', 'expenses', 'eligible', 'allowable', 'permitted', 'project', 'research', 'laboratory', 'lab', 'necessary', 'essential', 'reasonable', 'direct', 'new', 'not', 'no', 'prohibit', 'prohibits'])
const POSITIVE = /\b(?:eligible|allowable|permitted|covered|approved)\s+(?:project\s+)?(?:costs?|expenses?|uses?)\s*(?::|include\b|includes\b|are\b)|\b(?:funds?|funding|grants?|awards?|program)\s+(?:(?:may|can|will)\s+)?(?:be\s+)?(?:used\s+(?:for|on|to)|spent\s+on|cover(?:s)?|support(?:s)?|pay(?:s)?\s+for|fund(?:s)?)\b|\b(?:are|is)\s+(?:an?\s+)?(?:allowable|eligible|permitted|covered|reimbursable)\b/i
const NEGATIVE = /\b(?:not|never)\s+(?:be\s+)?(?:used|spent|eligible|allowable|permitted|covered|funded|supported|reimbursable)\b|\b(?:ineligible|unallowable|prohibited|excluded)\b|\b(?:does|do|will|can)\s+not\s+(?:cover|fund|support|pay)\b|\b(?:cannot|can't)\s+(?:be\s+)?(?:used|funded|covered)\b|(?:^|,)\s*(?:but\s+)?not\b|\b(?:except|excluding)\b/i
const CONDITIONAL = /\b(?:prior approval|subject to approval|provided that|as long as|upon approval|only (?:if|when|with)|unless|except|case[- ]by[- ]case|may be (?:allowable|eligible)|approval is required)\b/i

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[,:]/g, ' | ').replace(/[^a-z0-9|]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function textValues(value) {
  if (typeof value === 'string') {
    if (value.trimStart().startsWith('[') || value.trimStart().startsWith('{')) {
      try { return textValues(JSON.parse(value)) } catch { /* Treat malformed JSON as recorded text. */ }
    }
    return [value]
  }
  if (Array.isArray(value)) return value.slice(0, 30).flatMap(entry => typeof entry === 'string' ? [entry] : [])
  if (value && typeof value === 'object') return ['text', 'description', 'summary', 'requirements'].flatMap(key => typeof value[key] === 'string' ? [value[key]] : [])
  return []
}

function sourceUrl(row) {
  for (const value of [row.source_url, row.url, row.application_url]) {
    if (typeof value !== 'string') continue
    try { const url = new URL(value); if (/^https?:$/.test(url.protocol)) return url.href } catch { /* No invented URL. */ }
  }
  return null
}

function targetMatches(clause, requested) {
  const text = normalize(clause)
  const need = normalize(requested)
  if (!need) return false
  const rule = COST_RULES.find(candidate => candidate.request.test(need))
  if (rule?.capital && /\b(?:rent|rental|lease|leasing)\b/.test(text) && !/\b(?:purchase|acquisition|construction)\b/.test(text)) return false
  if (( ' ' + text + ' ').includes(' ' + need + ' ')) return true
  if (!rule) return false
  return rule.terms.some(term => {
    const haystack = ' ' + text + ' '
    const needle = ' ' + term + ' '
    let offset = haystack.indexOf(needle)
    while (offset !== -1) {
      const prefix = haystack.slice(0, offset).trim().split(' ').at(-1) || ''
      // A restricted subtype (school supplies, sports equipment, capacity building)
      // does not establish support for every expense sharing its last word.
      if (GENERIC_PREFIXES.has(prefix)) return true
      offset = haystack.indexOf(needle, offset + needle.length)
    }
    return false
  })
}

/** Evidence is a recorded source-field excerpt, not independently verified grant eligibility. */
export function evaluateRequestedFundingUses(row = {}, requests = []) {
  const url = sourceUrl(row)
  const clauses = TEXT_FIELDS.flatMap(field => textValues(row[field]).flatMap(text => text.slice(0, 24000)
    .split(/[.!?;\r\n]+/)
    .flatMap(sentence => (CONDITIONAL.test(sentence) ? [sentence] : sentence.split(/(?=\b(?:but|however)\b)|(?=,\s*(?:not|excluding)\b)/i)))
    .map(excerpt => ({ field, excerpt: excerpt.trim() })).filter(entry => entry.excerpt && entry.excerpt.length <= 400)))
  return requests.slice(0, 16).map(need => {
    const evidence = []
    const statuses = new Set()
    for (const { field, excerpt } of clauses) {
      if (!targetMatches(excerpt, need)) continue
      const negative = NEGATIVE.test(excerpt)
      const positive = POSITIVE.test(excerpt)
      if (!negative && !positive) continue
      const status = CONDITIONAL.test(excerpt) ? 'conditional' : negative ? 'excluded' : 'supported'
      statuses.add(status)
      if (evidence.length < 3) evidence.push({ field, excerpt: excerpt.slice(0, 400), source_url: url, status })
    }
    const status = statuses.has('conditional') || (statuses.has('supported') && statuses.has('excluded'))
      ? 'conditional' : statuses.has('excluded') ? 'excluded' : statuses.has('supported') ? 'supported' : 'unknown'
    return { need, status, evidence }
  })
}
