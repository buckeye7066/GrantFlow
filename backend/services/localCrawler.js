import fs from 'fs'
import { join } from 'path'
import { haversineDistanceMiles } from './sharedGeo.js'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  extractZipFromContext,
  buildProfileSignals,
  summarizeProfileSignals,
} from './profileHelpers.js'

const TOKEN_SPLIT = /[^a-z0-9]+/g

const DEMOGRAPHIC_KEYWORDS = {
  african_american: ['african american', 'black'],
  hispanic_latino: ['hispanic', 'latino', 'latina', 'latinx'],
  asian_american: ['asian american', 'asian', 'pacific islander', 'aapi'],
  native_american: ['native american', 'indigenous', 'tribal'],
  lgbtq: ['lgbtq', 'queer', 'transgender', 'nonbinary'],
  appalachian: ['appalachian'],
}

const GENDER_KEYWORDS = {
  female: ['women', 'woman', 'female', 'girls', 'girl'],
  male: ['men', 'man', 'male', 'boys', 'boy'],
  nonbinary: ['nonbinary', 'non-binary', 'genderqueer'],
}

const ASSISTANCE_KEYWORDS = {
  low_income: ['low income', 'need-based', 'financial need'],
  homeless: ['homeless', 'housing insecure'],
  ssi_recipient: ['ssi', 'supplemental security income'],
  ssdi_recipient: ['ssdi', 'social security disability'],
  snap_recipient: ['snap', 'food stamps'],
  tanf_recipient: ['tanf', 'temporary assistance for needy families'],
  section8_housing: ['section 8', 'housing voucher'],
  family_support: ['family support', 'caregiver'],
}

function loadJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function tokenizeText(targetSet, value) {
  if (!value) return
  const text = String(value).toLowerCase()
  text
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .forEach((token) => targetSet.add(token))
}

function buildOpportunityContext(opportunity) {
  const tokens = new Set()
  const textParts = []

  const collect = (value) => {
    if (!value) return
    const text = String(value).toLowerCase()
    textParts.push(text)
    tokenizeText(tokens, text)
  }

  collect(opportunity.title)
  collect(opportunity.description)
  collect(opportunity.sponsor)
  collect(opportunity.state)
  ;(opportunity.categories ?? []).forEach(collect)
  ;(opportunity.keywords ?? []).forEach(collect)
  ;(opportunity.eligibility_bullets ?? []).forEach(collect)

  return { tokens, blob: textParts.join(' ') }
}

function matchKeywords(blob, tokens, phrases) {
  const matches = new Set()
  if (!phrases) return matches
  phrases.forEach((phrase) => {
    const normalized = phrase?.toLowerCase?.() ?? ''
    if (!normalized || normalized.length <= 2) return
    if (normalized.includes(' ')) {
      if (blob.includes(normalized)) matches.add(normalized)
    } else if (tokens.has(normalized)) {
      matches.add(normalized)
    }
  })
  return matches
}

function matchMappedSignals(blob, tokens, signalSet, keywordMap) {
  const matches = new Set()
  if (!signalSet) return matches
  signalSet.forEach((flag) => {
    const synonyms = keywordMap[flag] ?? [flag.replace(/_/g, ' ')]
    const hit = synonyms.some((synonym) => {
      const normalized = synonym.toLowerCase()
      if (normalized.includes(' ')) return blob.includes(normalized)
      return tokens.has(normalized)
    })
    if (hit) {
      matches.add(flag.replace(/_/g, ' '))
    }
  })
  return matches
}

function scoreLocalOpportunity(opportunity, signals, distance, radius, context) {
  let score = 0
  const reasons = []

  const distanceScore = Math.max(0, radius - distance)
  score += 20 + (distanceScore / Math.max(radius, 1)) * 10
  reasons.push(`Within ${distance.toFixed(1)} miles`)

  if (signals.location?.state) {
    if (opportunity.state === signals.location.state) {
      score += 15
      reasons.push(`Matches state ${signals.location.state}`)
    } else if (opportunity.state) {
      score += 5
    }
  }

  const keywordMatches = matchKeywords(context.blob, context.tokens, signals.phrases)
  if (keywordMatches.size > 0) {
    score += keywordMatches.size * 3
    reasons.push(`Keyword overlap (${Array.from(keywordMatches).slice(0, 3).join(', ')})`)
  }

  const interestMatches = matchKeywords(context.blob, context.tokens, signals.interests)
  if (interestMatches.size > 0) {
    score += interestMatches.size * 5
    reasons.push(`Interest focus (${Array.from(interestMatches).slice(0, 3).join(', ')})`)
  }

  const demographicMatches = matchMappedSignals(context.blob, context.tokens, signals.demographics, DEMOGRAPHIC_KEYWORDS)
  if (demographicMatches.size > 0) {
    score += demographicMatches.size * 6
    reasons.push(`Demographic priority (${Array.from(demographicMatches).join(', ')})`)
  }

  const genderMatches = matchMappedSignals(context.blob, context.tokens, signals.genders, GENDER_KEYWORDS)
  if (genderMatches.size > 0) {
    score += genderMatches.size * 6
    reasons.push(`Gender alignment (${Array.from(genderMatches).join(', ')})`)
  }

  const assistanceMatches = matchMappedSignals(context.blob, context.tokens, signals.assistance, ASSISTANCE_KEYWORDS)
  if (assistanceMatches.size > 0) {
    score += assistanceMatches.size * 4
    reasons.push(`Assistance alignment (${Array.from(assistanceMatches).join(', ')})`)
  }

  if (signals.location?.city) {
    const city = signals.location.city.toLowerCase()
    if (context.blob.includes(city)) {
      score += 5
      reasons.push(`Serves city ${signals.location.city}`)
    }
  }

  return { score, reasons: Array.from(new Set(reasons)) }
}

export function processLocalCrawlerJob({
  db,
  job,
  profileContext,
  dataDir,
}) {
  const startTime = Date.now()
  const { profile, sections } = profileContext ?? {}
  if (!profile) {
    throw new Error('Local crawler requires a profile context')
  }

  const parameters = job.parameters ?? {}
  const zip = extractZipFromContext({
    profile,
    sections,
    jobParameters: parameters,
  })

  if (!zip) {
    throw new Error(
      'Unable to determine ZIP code for local crawler. Add a ZIP to the profile basic information or job parameters.',
    )
  }

  const radius = Number(parameters.radius_miles ?? 50)
  const signals = buildProfileSignals({ profile, sections })

  const zipCoords = loadJSON(join(dataDir, 'zip_coordinates.json'))
  const localOpportunities = loadJSON(
    join(dataDir, 'local_opportunities.json'),
  )

  const origin = zipCoords[zip]
  if (!origin) {
    throw new Error(
      `ZIP ${zip} is not currently indexed. Add coordinates to zip_coordinates.json to enable this area.`,
    )
  }

  const matches = localOpportunities
    .map((item) => {
      const distance = haversineDistanceMiles(
        origin.lat,
        origin.lng,
        item.lat,
        item.lng,
      )
      const context = buildOpportunityContext(item)
      const { score, reasons } = scoreLocalOpportunity(
        item,
        signals,
        distance,
        radius,
        context,
      )
      return { ...item, distance, match_score: score, match_reasons: reasons }
    })
    .filter((item) => item.distance <= radius)
    .filter((item) => item.match_score >= 20)
    .sort((a, b) => {
      if (b.match_score !== a.match_score) {
        return b.match_score - a.match_score
      }
      return a.distance - b.distance
    })
    .slice(0, parameters.limit ?? 10)

  if (matches.length === 0) {
    throw new Error(
      `No opportunities found within ${radius} miles of ZIP ${zip}. Extend the radius or add additional sources.`,
    )
  }

  let insertedCount = 0
  const opportunityLogs = []
  matches.forEach((opportunity) => {
    const matchSummary =
      opportunity.match_reasons?.length
        ? `Local match: ${opportunity.match_reasons.join('; ')}`
        : summarizeProfileSignals(signals)

    const result = upsertFundingOpportunity(db, {
      ...opportunity,
      source: 'local_crawler',
      source_id: opportunity.id,
      profile_id: profile.id,
      deadline_type: opportunity.deadline ? 'fixed' : 'rolling',
      match_reasons: opportunity.match_reasons ?? [],
      notes: matchSummary,
    })
    if (result.inserted) {
      insertedCount += 1
    }

    opportunityLogs.push({
      title: opportunity.title,
      sponsor: opportunity.sponsor,
      deadline: opportunity.deadline,
      distance_miles: Number.isFinite(opportunity.distance)
        ? Number(opportunity.distance.toFixed(1))
        : null,
      match_score: opportunity.match_score,
      match_reasons: opportunity.match_reasons,
      inserted: !!result.inserted,
    })
  })

  return {
    inserted: insertedCount,
    evaluated: matches.length,
    zip,
    radius,
    result_count: insertedCount,
    result_meta: {
      evaluated: matches.length,
      inserted: insertedCount,
      zip,
      radius,
      duration_seconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      opportunities: opportunityLogs,
    },
  }
}
