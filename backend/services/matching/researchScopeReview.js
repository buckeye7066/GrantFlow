// A shared broad "research" need does not establish fit for a named discipline.
// Only declared structured topics and the opportunity title establish scope;
// sponsor names and incidental prose never introduce a restriction.
const DOMAINS = [
  ['biological', /\b(biolog(?:y|ical)|biomedical|biotech(?:nology)?|bioinformatics|genomics|immunology|life sciences?)\b/i],
  ['mathematical', /\b(mathematics|mathematical|topology|algebra|number theory|geometry)\b/i],
  ['physical', /\b(physics|astrophysics|astronomy|geospace|plasma physics)\b/i],
  ['computing', /\b(computer science|computing|cybersecurity|software engineering)\b/i],
  ['ecological', /\b(ecology|ecological|conservation|wildlife|forestry|habitat restoration)\b/i],
  ['social', /\b(economics|sociology|anthropology|social sciences?)\b/i],
]
const BROAD_RESEARCH = /^(research|scientific research|research funding|innovation|research and development|r&d)$/i

function values(value) {
  if (Array.isArray(value)) return value.flatMap(values)
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.flatMap(values) } catch { /* plain text */ }
  return [value]
}

export function researchScopeReview({ profileContext = {}, opportunity = {}, dataPointEval = {}, matchedNeeds = [] } = {}) {
  const pointNeeds = (dataPointEval.matched ?? [])
    .filter(point => point.kind === 'need' && Number(point.credit) >= 1).map(point => String(point.value ?? ''))
  // Canonical coverage points outrank the legacy synonym-derived need list.
  const matched = pointNeeds.length ? pointNeeds : values(matchedNeeds)
  if (!matched.length || matched.some(need => !BROAD_RESEARCH.test(need.trim()))) return null
  const profile = profileContext.profile ?? profileContext
  const section = profileContext.sections?.programs_services ?? {}
  const programs = section.answers ?? section
  const declared = [profile.needs, profile.interests, programs.focus_areas, programs.interests].flatMap(values).join(' | ')
  const profileDomains = DOMAINS.filter(([, pattern]) => pattern.test(declared)).map(([name]) => name)
  const sourceDomains = DOMAINS.filter(([, pattern]) => pattern.test(String(opportunity.title ?? opportunity.name ?? ''))).map(([name]) => name)
  if (!profileDomains.length || !sourceDomains.length || sourceDomains.some(domain => profileDomains.includes(domain))) return null
  return `Research scope needs confirmation: source names ${sourceDomains.join('/')} research; declared profile topics are ${profileDomains.join('/')}. Generic research overlap is insufficient for automatic acceptance.`
}
