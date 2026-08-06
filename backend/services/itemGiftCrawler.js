/**
 * Item Gift Crawler (DIRECTORY)
 *
 * Goal:
 * - When a user searches for an item (e.g. "computer", "handicap van"),
 *   return REAL organizations/programs that donate or give access to that item.
 * - Every returned record MUST include a real URL and at least one contact method
 *   (contact page URL, email, or phone).
 *
 * Storage:
 * - Saved into `funding_opportunities` as type='DIRECTORY' and opportunity_type='in_kind'
 *   so it shows up in existing discovery UIs without inventing new API shapes.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from './opportunityInserter.js'
import { scoreOpportunity } from './matchEngine.js'
import { DEFAULT_MIN_SCORE, RELAX_THRESHOLDS, SCORE_SCALE_ID } from '../config/matchThresholds.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('itemGiftCrawler')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function safeJsonRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn('[itemGiftCrawler] Sources file not found:', filePath)
      return null
    }
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    console.warn('[itemGiftCrawler] Failed to read sources JSON:', filePath, error?.message || String(error))
    return null
  }
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function tokenize(query) {
  return normalizeText(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 24)
}

function hasContact(source) {
  return Boolean(source?.contact_url || source?.contact_email || source?.contact_phone)
}

function loadGiftSources() {
  // Repo-safe location (checked in)
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'crawlers', 'item_gift_sources.json')
  const parsed = safeJsonRead(fixturePath)
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : []
  return sources
}

export async function processItemGiftCrawlerJob({ db, job, profileContext }) {
  const parameters = job?.parameters ?? {}
  const item = normalizeText(parameters.item || parameters.item_request || parameters.search || '')
  const tokens = tokenize(item)

  if (!item) {
    console.warn('[itemGiftCrawler] Missing item parameter', { jobId: job?.id ?? null })
    return { evaluated: 0, inserted: 0, matched: 0, opportunityLogs: [], result_meta: { item: null } }
  }

  const profileId = profileContext?.profile?.id ?? job?.profile_id ?? null
  const sources = loadGiftSources()

  // Score + filter: must have URL + contact method.
  const candidates = (sources || [])
    .filter((s) => s && s.website_url && hasContact(s))
    .map((s) => {
      // Build a synthetic opportunity from the gift source so the canonical engine can score it.
      const syntheticOpp = {
        title: s.name,
        description: [s.notes, ...(s.item_tags || []), item].filter(Boolean).join(' '),
        sponsor: s.name,
        source_url: s.website_url,
        application_url: s.contact_url ?? s.website_url,
        state: 'nationwide',
        is_national: true,
        keywords: [...(s.item_tags || []), item, ...tokens],
        categories: ['in-kind', 'donation'],
      }
      // Use profileContext if available, otherwise pass the synthetic opp alone (no profile signals)
      const { score: baseScore } = scoreOpportunity(profileContext?.profile ? profileContext : { profile: null }, syntheticOpp)
      // Apply directory-specific contact-availability bonus (not a profile-match concept).
      let score = baseScore
      if (s.contact_url) score = Math.min(100, score + 8)
      if (s.contact_email) score = Math.min(100, score + 6)
      if (s.contact_phone) score = Math.min(100, score + 4)
      return { ...s, match_score: Math.round(score) }
    })
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  // Do not allow "0 results" when we have any candidates; relax threshold automatically.
  const parsedThreshold = Number(parameters.match_threshold ?? DEFAULT_MIN_SCORE)
  const requestedThreshold = Number.isFinite(parsedThreshold)
    ? Math.max(0, Math.min(100, parsedThreshold))
    : DEFAULT_MIN_SCORE
  const thresholds = Array.from(new Set([
    requestedThreshold,
    ...RELAX_THRESHOLDS.filter((threshold) => threshold < requestedThreshold),
  ]))

  let thresholdUsed = requestedThreshold
  let filtered = candidates.filter((c) => (c.match_score ?? 0) >= thresholdUsed)
  for (const th of thresholds) {
    const subset = candidates.filter((c) => (c.match_score ?? 0) >= th)
    if (subset.length >= 3 || (th === 0 && subset.length > 0)) {
      thresholdUsed = th
      filtered = subset
      break
    }
  }

  const maxResults = Number(parameters.max_results ?? 20)
  const top = filtered.slice(0, Number.isFinite(maxResults) ? maxResults : 20)

  let upserted = 0
  const logs = []

  for (const src of top) {
    const contactInfo = {
      name: src.name,
      website: src.website_url,
      contact_url: src.contact_url ?? null,
      email: src.contact_email ?? null,
      phone: src.contact_phone ?? null,
    }

    const title = `${src.name} — ${item} assistance / donated items`
    const description = [
      `Directory entry: ${src.name}.`,
      src.notes ? src.notes : null,
      'Use the contact link to confirm eligibility and current availability.',
    ]
      .filter(Boolean)
      .join(' ')

    const result = await upsertFundingOpportunity(db, {
      title,
      sponsor: src.name,
      source: 'item_gift',
      source_id: src.id || undefined,
      source_url: src.website_url,
      evidence_url: src.contact_url ?? src.website_url,
      description,
      application_url: src.contact_url ?? src.website_url,
      record_origin: 'curated_verified',
      opportunity_type: 'in_kind',
      type: 'DIRECTORY',
      is_national: true,
      state: 'nationwide',
      categories: ['in-kind', 'donation', 'item-gift'],
      keywords: Array.from(new Set([item, ...tokens, ...(src.item_tags || [])].map((v) => String(v)))).slice(0, 50),
      match_reasons: [
        `Item query: ${item}`,
        `Crawler rank score: ${src.match_score} (${SCORE_SCALE_ID} fit plus contact availability)`,
        src.contact_url ? 'Has contact page' : null,
        src.contact_email ? 'Has contact email' : null,
        src.contact_phone ? 'Has contact phone' : null,
      ].filter(Boolean),
      contact_info: JSON.stringify(contactInfo),
      profile_id: profileId,
      // Never require match for directory resources
      requires_match: false,
      requires_501c3: false,
    })

    if (result?.id) upserted += 1
    logs.push({
      title,
      sponsor: src.name,
      score: src.match_score,
      url: src.website_url,
      contact_url: src.contact_url ?? null,
    })
  }

  log.info('[itemGiftCrawler] completed', {
    jobId: job?.id ?? null,
    profileId,
    item,
    evaluated: candidates.length,
    matched: top.length,
    inserted: upserted,
    thresholdRequested: requestedThreshold,
    thresholdUsed,
  })

  return {
    evaluated: candidates.length,
    matched: top.length,
    inserted: upserted,
    result_meta: {
      item,
      score_scale: SCORE_SCALE_ID,
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      sources_considered: candidates.length,
      sources_returned: top.length,
    },
    opportunityLogs: logs,
  }
}

export default processItemGiftCrawlerJob
