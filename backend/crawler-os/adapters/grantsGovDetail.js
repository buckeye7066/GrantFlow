// Search2 discovers identities. Only the matching award's synopsis supplies
// eligibility, purpose, dates and award amounts. No LLM or source-taxonomy
// fallback is used to invent those facts.
import { GRANTS_GOV_FETCH_OPPORTUNITY_URL, parseApiAmount, resolveGrantsGovIdentity } from '../../../shared/grantsGovProtocol.js'
import { inferCandidateProfile } from '../crawlerVocabulary.js'

const APPLICANT_BUCKETS = Object.freeze({
  '00': 'government', '01': 'government', '02': 'government', '04': 'government',
  '05': 'school', '06': 'organization', '07': 'government', '08': 'government',
  '11': 'nonprofit', '12': 'nonprofit', '13': 'nonprofit', '20': 'organization',
  '21': 'individual', '22': 'business', '23': 'business',
})

function calendar(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-|$)/.exec(String(value ?? ''))
  return match?.[1] ?? null
}

export async function enrichGrantsGovCandidate(candidate, { fetcher, cache, deadlineMs, clock = Date.now } = {}) {
  const identity = resolveGrantsGovIdentity(candidate.raw)
  const id = Number(identity.detailId)
  if (!Number.isSafeInteger(id) || id <= 0) return { candidate, reason: 'detail_id_missing' }
  const key = `grants.gov:${id}`
  let response = cache.get(key)
  if (!response) {
    if (Number.isFinite(deadlineMs) && clock() >= deadlineMs) return { candidate, reason: 'time_budget_exhausted' }
    response = await fetcher.fetch(GRANTS_GOV_FETCH_OPPORTUNITY_URL, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ opportunityId: id }),
      ...(Number.isFinite(deadlineMs) ? { signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs - clock()))) } : {}),
    })
    cache.set(key, response)
  }
  if (!response.ok) return { candidate, reason: `detail_fetch_failed:${response.status ?? response.error ?? 'unknown'}` }
  let body
  try { body = JSON.parse(response.body) } catch { return { candidate, reason: 'detail_parse_failed' } }
  const data = body?.data
  const synopsis = data?.synopsis
  if (Number(body?.errorcode) !== 0 || Number(data?.id) !== id || Number(synopsis?.opportunityId) !== id || !synopsis) {
    return { candidate, reason: 'detail_identity_or_synopsis_missing' }
  }
  if (identity.opportunityNumber && data.opportunityNumber && data.opportunityNumber !== identity.opportunityNumber) {
    return { candidate, reason: 'detail_number_mismatch' }
  }
  const stated = (Array.isArray(synopsis.applicantTypes) ? synopsis.applicantTypes : [])
    .filter(v => v && typeof v.description === 'string' && String(v.id ?? '').trim())
  const codes = [...new Set(stated.map(v => String(v.id)))]
  const descriptions = stated.map(v => v.description.trim()).filter(Boolean)
  const evidence = { url: response.finalUrl ?? GRANTS_GOV_FETCH_OPPORTUNITY_URL, content_hash: response.contentHash ?? null, fetched_at: response.fetchedAt ?? null }
  const summary = typeof synopsis.synopsisDesc === 'string' ? synopsis.synopsisDesc : null
  const categories = inferCandidateProfile({ summary }, {})
  return {
    candidate: {
      ...candidate,
      title: data.opportunityTitle || candidate.title,
      summary,
      applicant_types: [...new Set(codes.map(code => APPLICANT_BUCKETS[code]).filter(Boolean))],
      need_categories: categories.need_categories.filter(v => v !== '*'),
      eligibility_bullets: descriptions,
      eligibility_text: synopsis.applicantEligibilityDesc ?? null,
      open_date: calendar(synopsis.postingDateStr) ?? candidate.open_date ?? null,
      deadline: calendar(synopsis.responseDateStr) ?? candidate.deadline ?? null,
      amount_min: parseApiAmount(synopsis.awardFloor), amount_max: parseApiAmount(synopsis.awardCeiling),
      is_loan: candidate.is_loan === true || (Array.isArray(synopsis.fundingInstruments) &&
        synopsis.fundingInstruments.some(value => /^(?:(?:direct|guaranteed|insured) )?loans?$/i.test(String(value?.description ?? '').trim()))),
      requires_cost_share: synopsis.costSharing === true,
      field_provenance: { ...(candidate.field_provenance ?? {}), applicant_types: {
        source: 'grants.gov', method: 'fetchOpportunity', opportunity_id: id,
        allowed_codes: codes, descriptions, ...evidence,
      } },
    },
    evidence,
  }
}
