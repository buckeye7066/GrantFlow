import crypto from 'crypto'

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function inferProgramType(text = '') {
  const t = text.toLowerCase()
  if (t.includes('waiver') || t.includes('hcbs')) return 'Waiver'
  if (t.includes('reimbursement') || t.includes('rate') || t.includes('billing')) return 'Reimbursement'
  if (t.includes('subsidy')) return 'Subsidy'
  if (t.includes('grant')) return 'Grant'
  if (t.includes('benefit') || t.includes('eligib')) return 'Benefit'
  return 'Benefit'
}

function looksProviderTrack(text = '') {
  const t = text.toLowerCase()
  return (
    t.includes('provider') ||
    t.includes('caregiver') ||
    t.includes('workforce') ||
    t.includes('training') ||
    t.includes('reimbursement') ||
    t.includes('rate increase') ||
    t.includes('capital') ||
    t.includes('compliance') ||
    t.includes('retention')
  )
}

function looksClientTrack(text = '') {
  const t = text.toLowerCase()
  return (
    t.includes('medicaid') ||
    t.includes('benefit') ||
    t.includes('eligibility') ||
    t.includes('enroll') ||
    t.includes('ssi') ||
    t.includes('ssdi') ||
    t.includes('snap') ||
    t.includes('housing') ||
    t.includes('transportation')
  )
}

export function buildCanonicalKey({
  fundingTrack,
  jurisdiction,
  state,
  county,
  administeringAgency,
  programName,
  sourceUrl,
}) {
  const parts = [
    `track:${fundingTrack}`,
    `jur:${jurisdiction}`,
    `state:${state || ''}`,
    `county:${county || ''}`,
    `agency:${(administeringAgency || '').toLowerCase().trim()}`,
    `name:${(programName || '').toLowerCase().trim()}`,
    `url:${(sourceUrl || '').toLowerCase().trim()}`,
  ]
  return parts.join('|')
}

export function normalizeFromDocument({
  agent,
  doc,
  url,
  jurisdiction,
  state,
  county,
  administeringAgency,
}) {
  const extractedText = doc?.extractedText || ''
  const programName = firstNonEmpty(doc?.h1, doc?.title, agent?.defaultProgramName) || 'Unknown Program'
  const programType = inferProgramType(extractedText)
  const base = {
    program_name: programName,
    jurisdiction,
    state: state || null,
    county: county || null,
    administering_agency: administeringAgency || agent?.administeringAgency || null,
    program_type: programType,
    eligible_population: null,
    covered_services: null,
    income_limits: null,
    diagnosis_requirements: null,
    age_requirements: null,
    funding_amounts: [],
    renewal_cycle: null,
    application_method: null,
    source_url: url,
    last_verified: new Date().toISOString(),
  }

  // Cheap heuristic fills (placeholder until state-by-state rule modules add precision)
  const t = extractedText.toLowerCase()
  if (t.includes('apply') || t.includes('application')) base.application_method = 'See source URL'
  if (t.includes('phone') || t.includes('call')) base.application_method = base.application_method || 'See source URL'
  if (t.includes('eligib')) base.eligible_population = 'See source URL'
  if (t.includes('covered') || t.includes('services')) base.covered_services = 'See source URL'

  const provider = looksProviderTrack(extractedText)
  const client = looksClientTrack(extractedText)

  const tracks = []
  if (client) tracks.push('CLIENT')
  if (provider) tracks.push('PROVIDER')
  if (tracks.length === 0) tracks.push(agent?.defaultTrack || 'CLIENT')

  const contentHash = sha256(extractedText)
  const sourceUrlHash = sha256(url)

  return {
    tracks,
    base,
    extracted_text: extractedText,
    content_hash: contentHash,
    source_url_hash: sourceUrlHash,
  }
}

