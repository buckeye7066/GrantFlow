import crypto from 'crypto'
import { computeConfidence } from '../nationalPrograms/confidence.js'

function sha256(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex')
}

function cleanArray(lines) {
  const items = (Array.isArray(lines) ? lines : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  return Array.from(new Set(items)).slice(0, 50)
}

function pickSection(text, keywords) {
  const lower = (text || '').toLowerCase()
  let bestIdx = -1
  let bestKey = null
  keywords.forEach((k) => {
    const idx = lower.indexOf(k)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx
      bestKey = k
    }
  })
  if (bestIdx === -1) return null

  // take window after keyword until next blankline-ish chunk
  const window = text.slice(bestIdx, bestIdx + 2500)
  return { key: bestKey, window }
}

function extractBullets(window) {
  if (!window) return []
  const lines = window
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-•*]\s*/, '').trim())
    .filter((l) => l.length > 0)
  // heuristic: keep mid-length lines
  return cleanArray(lines.filter((l) => l.length >= 4 && l.length <= 140))
}

function inferProgramType(text) {
  const t = (text || '').toLowerCase()
  if (t.includes('waiver') || t.includes('hcbs')) return 'waiver'
  if (t.includes('reimbursement') || t.includes('rate')) return 'reimbursement'
  if (t.includes('subsidy')) return 'subsidy'
  if (t.includes('grant')) return 'grant'
  if (t.includes('benefit') || t.includes('eligib')) return 'benefit'
  return 'other'
}

function looksTrackB(text) {
  const t = (text || '').toLowerCase()
  return (
    t.includes('provider') ||
    t.includes('caregiver') ||
    t.includes('agency') ||
    t.includes('workforce') ||
    t.includes('reimbursement') ||
    t.includes('rate increase') ||
    t.includes('retention')
  )
}

function looksTrackA(text) {
  const t = (text || '').toLowerCase()
  return (
    t.includes('benefit') ||
    t.includes('eligib') ||
    t.includes('enroll') ||
    t.includes('medicaid') ||
    t.includes('ssi') ||
    t.includes('ssdi') ||
    t.includes('snap') ||
    t.includes('housing') ||
    t.includes('transportation')
  )
}

export function deterministicProgramId({
  funding_track,
  jurisdiction,
  state,
  county,
  source_url,
  program_name,
  administering_agency,
}) {
  const key = [
    `track=${funding_track}`,
    `jur=${jurisdiction}`,
    `state=${state || ''}`,
    `county=${county || ''}`,
    `agency=${(administering_agency || '').toLowerCase().trim()}`,
    `name=${(program_name || '').toLowerCase().trim()}`,
    `url=${(source_url || '').toLowerCase().trim()}`,
  ].join('|')
  return sha256(key)
}

export function normalizeProgram({
  source,
  url,
  extractedText,
  parsedDoc,
  contentHash,
  fetchedAt,
  httpStatus,
  contentType,
  parserName,
}) {
  const programName = (parsedDoc?.h1 || parsedDoc?.title || source?.name || 'Unknown Program').trim()
  const programType = inferProgramType(extractedText)

  const eligibleSection = pickSection(extractedText, ['eligibility', 'who is eligible', 'who qualifies'])
  const coveredSection = pickSection(extractedText, ['covered services', 'benefits', 'services', 'what we cover'])
  const applySection = pickSection(extractedText, ['how to apply', 'apply', 'application'])

  const eligible_population = eligibleSection ? extractBullets(eligibleSection.window) : []
  const covered_services = coveredSection ? extractBullets(coveredSection.window) : []

  const application_method = applySection ? 'See source for instructions' : null
  const application_url = url

  const raw_source_refs = [{ url, hash: contentHash }]

  const base = {
    program_name: programName,
    jurisdiction: source.jurisdiction,
    state: source.state || null,
    county: source.county || null,
    administering_agency: source.configuration?.agency || null,
    program_type: programType,
    eligible_population,
    covered_services,
    income_limits: null,
    diagnosis_requirements: null,
    age_requirements: null,
    funding_amounts: null,
    renewal_cycle: null,
    application_method,
    application_url,
    source_url: url,
    source_last_crawled_at: fetchedAt,
    last_verified: fetchedAt,
    raw_source_refs,
    http_status: httpStatus ?? null,
    content_type: contentType ?? null,
    parser_name: parserName ?? null,
  }

  const text = extractedText || ''
  const hints = Array.isArray(source?.configuration?.track_hints) ? source.configuration.track_hints : []

  // If hints are provided, treat them as authoritative (prevents accidental cross-track inference).
  const tracks = []
  if (hints.length > 0) {
    hints.forEach((h) => {
      if (h === 'TRACK_A' || h === 'TRACK_B') tracks.push(h)
    })
  } else {
    const inferredA = looksTrackA(text)
    const inferredB = looksTrackB(text)
    if (inferredA) tracks.push('TRACK_A')
    if (inferredB) tracks.push('TRACK_B')
  }

  if (tracks.length === 0) tracks.push('TRACK_A')

  const normalizedByTrack = tracks.map((track) => {
    const row = {
      program_id: deterministicProgramId({
        funding_track: track,
        jurisdiction: base.jurisdiction,
        state: base.state,
        county: base.county,
        source_url: base.source_url,
        program_name: base.program_name,
        administering_agency: base.administering_agency,
      }),
      funding_track: track,
      ...base,
    }

    if (track === 'TRACK_A') {
      row.provider_requirements = null
    } else {
      row.provider_requirements = null
    }

    // reuse existing confidence helper by mapping keys
    const confidenceScore = computeConfidence(
      track === 'TRACK_B' ? 'PROVIDER' : 'CLIENT',
      {
        program_name: row.program_name,
        funding_track: track === 'TRACK_B' ? 'PROVIDER' : 'CLIENT',
        jurisdiction: row.jurisdiction,
        administering_agency: row.administering_agency,
        program_type: row.program_type,
        eligible_population: row.eligible_population,
        covered_services: row.covered_services,
        provider_requirements: row.provider_requirements,
        application_method: row.application_method,
        source_url: row.source_url,
        funding_amounts: row.funding_amounts,
      },
    )

    row.confidence_score = confidenceScore
    return row
  })

  return {
    normalizedByTrack,
    raw_source_refs,
  }
}

