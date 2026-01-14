import fs from 'fs'
import { join } from 'path'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { saveToProfilePipeline } from './opportunityMatcher.js'
import {
  extractStateFromContext,
  extractStudentCampusZip,
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
  female: ['female', 'women', 'woman', 'girls', 'girl'],
  male: ['male', 'men', 'man', 'boys', 'boy'],
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

const MILITARY_KEYWORDS = {
  veteran: ['veteran', 'military veteran'],
  active_duty_military: ['active duty'],
  national_guard: ['national guard', 'guard'],
  disabled_veteran: ['disabled veteran'],
  military_spouse: ['military spouse'],
  military_dependent: ['military dependent'],
  gold_star_family: ['gold star family'],
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
  ;(opportunity.categories ?? []).forEach(collect)
  ;(opportunity.keywords ?? []).forEach(collect)
  ;(opportunity.tags ?? []).forEach(collect)
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
    if (hit) matches.add(flag.replace(/_/g, ' '))
  })
  return matches
}

function parseGpaRequirement(blob) {
  const match = blob.match(/gpa[^0-9]*(\d(?:\.\d+)?)/)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}

function parseActRequirement(blob) {
  const match = blob.match(/act[^0-9]*(\d{1,2})/)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

function parseSatRequirement(blob) {
  const match = blob.match(/sat[^0-9]*(\d{3,4})/)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

function scoreScholarshipOpportunity(opportunity, signals, state, campusZip, context) {
  let score = 0
  const reasons = []

  if (opportunity.states?.includes('ALL')) {
    score += 12
    reasons.push('National eligibility')
  }

  if (state && opportunity.states?.includes(state)) {
    score += 22
    reasons.push(`Matches state ${state}`)
  }

  if (campusZip && (opportunity.tags ?? []).includes('campus_zip')) {
    score += 6
    reasons.push('Campus ZIP alignment')
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
    score += demographicMatches.size * 8
    reasons.push(`Demographic priority (${Array.from(demographicMatches).join(', ')})`)
  }

  const genderMatches = matchMappedSignals(context.blob, context.tokens, signals.genders, GENDER_KEYWORDS)
  if (genderMatches.size > 0) {
    score += genderMatches.size * 8
    reasons.push(`Gender alignment (${Array.from(genderMatches).join(', ')})`)
  }

  const assistanceMatches = matchMappedSignals(context.blob, context.tokens, signals.assistance, ASSISTANCE_KEYWORDS)
  if (assistanceMatches.size > 0) {
    score += assistanceMatches.size * 6
    reasons.push(`Assistance alignment (${Array.from(assistanceMatches).join(', ')})`)
  }

  const militaryMatches = matchMappedSignals(context.blob, context.tokens, signals.military, MILITARY_KEYWORDS)
  if (militaryMatches.size > 0) {
    score += militaryMatches.size * 6
    reasons.push(`Military preference (${Array.from(militaryMatches).join(', ')})`)
  }

  const gpaRequirement = parseGpaRequirement(context.blob)
  if (gpaRequirement && signals.academics?.gpa) {
    if (signals.academics.gpa >= gpaRequirement) {
      score += 8
      reasons.push(`Meets GPA requirement (${gpaRequirement.toFixed(2)}+)`)
    }
  }

  const actRequirement = parseActRequirement(context.blob)
  if (actRequirement && signals.academics?.act) {
    if (signals.academics.act >= actRequirement) {
      score += 6
      reasons.push(`ACT ready (${signals.academics.act} vs ${actRequirement})`)
    }
  }

  const satRequirement = parseSatRequirement(context.blob)
  if (satRequirement && signals.academics?.sat) {
    if (signals.academics.sat >= satRequirement) {
      score += 6
      reasons.push(`SAT ready (${signals.academics.sat} vs ${satRequirement})`)
    }
  }

  if (signals.applicantTypes?.size) {
    const applicantMatch = matchKeywords(context.blob, context.tokens, signals.applicantTypes)
    if (applicantMatch.size > 0) {
      score += applicantMatch.size * 4
      reasons.push(`Applicant profile (${Array.from(applicantMatch).join(', ')})`)
    }
  }

  return { score, reasons: Array.from(new Set(reasons)) }
}

export async function processScholarshipCrawlerJob({
  db,
  job,
  profileContext,
  dataDir,
}) {
  const startTime = Date.now()
  const { profile, sections } = profileContext ?? {}
  if (!profile) {
    throw new Error('Scholarship crawler requires a profile context')
  }

  const state = extractStateFromContext({
    profile,
    sections,
    jobParameters: job.parameters ?? {},
  })
  const campusZip = extractStudentCampusZip({
    sections,
    jobParameters: job.parameters ?? {},
  })
  const signals = buildProfileSignals({ profile, sections })

  const scholarships = loadJSON(
    join(dataDir, 'scholarship_opportunities.json'),
  )

  const scored = scholarships
    .map((opportunity) => {
      const context = buildOpportunityContext(opportunity)
      const { score, reasons } = scoreScholarshipOpportunity(
        opportunity,
        signals,
        state,
        campusZip,
        context,
      )
      return { opportunity, score, reasons }
    })
    .filter(({ score }) => score >= 25)
    .sort((a, b) => b.score - a.score)
    .slice(0, job.parameters?.limit ?? 8)

  if (scored.length === 0) {
    // No matches is a valid outcome; mark job completed with zero results.
    return {
      evaluated: Array.isArray(scholarships) ? scholarships.length : 0,
      matched: 0,
      inserted: 0,
      savedToPipeline: 0,
      result_meta: {
        inserted: 0,
        evaluated: Array.isArray(scholarships) ? scholarships.length : 0,
        matched: 0,
        note: 'No scholarship matches found',
      },
      opportunityLogs: [],
    }
  }

  let inserted = 0
  let savedToPipeline = 0
  const profileId = profileContext?.profile?.id
  const opportunityLogs = []
  scored.forEach(({ opportunity, score, reasons }) => {
    const matchSummary =
      reasons.length > 0 ? `Scholarship match: ${reasons.join('; ')} (score ${score})` : summarizeProfileSignals(signals)

    const result = await upsertFundingOpportunity(db, {
      ...opportunity,
      source: 'scholarship_crawler',
      source_id: opportunity.id,
      profile_id: null,
      deadline_type: 'fixed',
      categories: opportunity.categories,
      keywords: opportunity.keywords,
      match_reasons: reasons,
      notes: matchSummary,
      requires_match: false,
      requires_501c3: false,
    })
    if (result.inserted) {
      inserted += 1
    }

    // Save to profile pipeline if match >= 80%
    if (profileId && score >= 80) {
      const oppWithId = { ...opportunity, id: result.id }
      const pipelineResult = await saveToProfilePipeline(db, oppWithId, profileId, profileContext, score)
      if (pipelineResult.saved) {
        savedToPipeline++
      }
    }

    opportunityLogs.push({
      title: opportunity.title,
      sponsor: opportunity.sponsor,
      deadline: opportunity.deadline,
      match_score: score,
      match_reasons: reasons,
      inserted: !!result.inserted,
    })
  })
  
  console.log(`[scholarshipCrawler] Saved ${savedToPipeline} scholarships to profile pipeline (≥80% match)`)

  return {
    inserted,
    evaluated: scored.length,
    savedToPipeline,
    result_count: inserted,
    result_meta: {
      evaluated: scored.length,
      inserted,
      savedToPipeline,
      duration_seconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      opportunities: opportunityLogs,
    },
  }
}
