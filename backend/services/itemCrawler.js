import fs from 'fs'
import { join } from 'path'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import {
  extractStateFromContext,
  extractZipFromContext,
  buildProfileSignals,
  summarizeProfileSignals,
} from './profileHelpers.js'

const TOKEN_SPLIT = /[^a-z0-9]+/g

const DEMOGRAPHIC_KEYWORDS = {
  african_american: ['african american', 'black'],
  hispanic_latino: ['hispanic', 'latino', 'latina', 'latinx'],
  asian_american: ['asian american', 'asian', 'aapi'],
  native_american: ['native american', 'indigenous', 'tribal'],
  lgbtq: ['lgbtq', 'queer', 'transgender', 'nonbinary'],
  appalachian: ['appalachian'],
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

function buildEntryContext(entry) {
  const tokens = new Set()
  const textParts = []

  const collect = (value) => {
    if (!value) return
    const text = String(value).toLowerCase()
    textParts.push(text)
    tokenizeText(tokens, text)
  }

  collect(entry.title)
  collect(entry.description)
  ;(entry.categories ?? []).forEach(collect)
  ;(entry.keywords ?? []).forEach(collect)
  ;(entry.keywords_extra ?? []).forEach(collect)

  return { tokens, blob: textParts.join(' ') }
}

function keywordScoreFromQuery(context, query) {
  if (!query) return 0
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (terms.length === 0) return 0
  let score = 0
  terms.forEach((term) => {
    if (term.length <= 2) return
    if (context.tokens.has(term)) {
      score += 12
    } else if (context.blob.includes(term)) {
      score += 8
    }
  })
  return score
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

function scoreItemFundingSource(entry, signals, state, zip, query, context) {
  let score = 0
  const reasons = []

  score += keywordScoreFromQuery(context, query)
  if (score > 0) {
    reasons.push(`Matches item request "${query}"`)
  }

  if (state) {
    if (entry.states?.includes('ALL')) {
      score += 6
      reasons.push('Available nationally')
    } else if (entry.states?.includes(state)) {
      score += 12
      reasons.push(`Supports projects in ${state}`)
    }
  }

  if (zip && entry.regional_zips?.includes(zip)) {
    score += 6
    reasons.push(`Targets ZIP ${zip}`)
  }

  const interestMatches = matchKeywords(context.blob, context.tokens, signals.interests)
  if (interestMatches.size > 0) {
    score += interestMatches.size * 5
    reasons.push(`Aligns with interests (${Array.from(interestMatches).slice(0, 3).join(', ')})`)
  }

  const demographicMatches = matchMappedSignals(context.blob, context.tokens, signals.demographics, DEMOGRAPHIC_KEYWORDS)
  if (demographicMatches.size > 0) {
    score += demographicMatches.size * 6
    reasons.push(`Supports demographics (${Array.from(demographicMatches).join(', ')})`)
  }

  const assistanceMatches = matchMappedSignals(context.blob, context.tokens, signals.assistance, ASSISTANCE_KEYWORDS)
  if (assistanceMatches.size > 0) {
    score += assistanceMatches.size * 5
    reasons.push(`Assistance alignment (${Array.from(assistanceMatches).join(', ')})`)
  }

  const keywordMatches = matchKeywords(context.blob, context.tokens, signals.phrases)
  if (keywordMatches.size > 0) {
    score += keywordMatches.size * 3
    reasons.push(`Keyword overlap (${Array.from(keywordMatches).slice(0, 3).join(', ')})`)
  }

  return { score, reasons: Array.from(new Set(reasons)) }
}

export function processItemCrawlerJob({
  db,
  job,
  profileContext,
  dataDir,
}) {
  const startTime = Date.now()
  const parameters = job.parameters ?? {}
  const { profile, sections } = profileContext ?? {}

  if (!parameters.item) {
    throw new Error('Item search requires an "item" parameter')
  }

  const state =
    parameters.state ||
    extractStateFromContext({
      profile,
      sections,
      jobParameters: parameters,
    })
  const zip = extractZipFromContext({
    profile,
    sections,
    jobParameters: parameters,
  })

  const signals = buildProfileSignals({ profile, sections })
  const catalogue = loadJSON(
    join(dataDir, 'item_funding_sources.json'),
  )

  const scored = catalogue
    .map((entry) => {
      const context = buildEntryContext(entry)
      const { score, reasons } = scoreItemFundingSource(
        entry,
        signals,
        state,
        zip,
        parameters.item,
        context,
      )
      return { entry, score, reasons }
    })
    .filter(({ score }) => score >= 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, parameters.limit ?? 6)

  if (scored.length === 0) {
    throw new Error(
      `No funding sources matched the item "${parameters.item}". Update catalogue or refine the query.`,
    )
  }

  let inserted = 0
  const opportunityLogs = []
  scored.forEach(({ entry, score, reasons }) => {
    const result = upsertFundingOpportunity(db, {
      ...entry,
      source: 'item_search_crawler',
      source_id: entry.id,
      profile_id: profile?.id ?? null,
      deadline_type: entry.deadline ? 'fixed' : 'rolling',
      categories: entry.categories,
      keywords: [
        ...(entry.keywords ?? []),
        ...(entry.keywords_extra ?? []),
      ],
      match_reasons: reasons,
      notes:
        reasons.length > 0
          ? `Item match: ${reasons.join('; ')} (score ${score})`
          : summarizeProfileSignals(signals),
      requires_match: false,
      requires_501c3: false,
    })
    if (result.inserted) {
      inserted += 1
    }

    opportunityLogs.push({
      title: entry.title,
      sponsor: entry.sponsor,
      deadline: entry.deadline,
      match_score: score,
      match_reasons: reasons,
      inserted: !!result.inserted,
    })
  })

  return {
    inserted,
    evaluated: scored.length,
    item: parameters.item,
    result_count: inserted,
    result_meta: {
      evaluated: scored.length,
      inserted,
      item: parameters.item,
      duration_seconds: Math.max(0, Math.round((Date.now() - startTime) / 1000)),
      opportunities: opportunityLogs,
    },
  }
}
