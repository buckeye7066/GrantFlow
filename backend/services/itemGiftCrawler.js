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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function safeJsonRead(filePath) {
  try {
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

function computeMatchScore(source, tokens) {
  // Keep this simple and inclusive; we never hard-filter on missing profile fields.
  const tags = Array.isArray(source?.item_tags) ? source.item_tags.map((t) => String(t).toLowerCase()) : []
  const notes = String(source?.notes || '').toLowerCase()
  const name = String(source?.name || '').toLowerCase()

  let score = 40
  let matches = 0
  for (const token of tokens) {
    if (token.length < 3) continue
    if (tags.some((t) => t.includes(token) || token.includes(t))) {
      matches += 1
    } else if (name.includes(token) || notes.includes(token)) {
      matches += 1
    }
  }

  score += Math.min(50, matches * 12)

  // Strong preference for sources that clearly publish a contact page.
  if (source?.contact_url) score += 8
  if (source?.contact_email) score += 6
  if (source?.contact_phone) score += 4

  return Math.max(0, Math.min(100, Math.round(score)))
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
    .map((s) => ({
      ...s,
      match_score: computeMatchScore(s, tokens),
    }))
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))

  // Do not allow "0 results" when we have any candidates; relax threshold automatically.
  const requestedThreshold = Number(parameters.match_threshold ?? 55)
  const thresholds = Array.from(new Set([requestedThreshold, 70, 60, 55, 45, 35, 0]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)

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
        `Match score: ${src.match_score}%`,
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

  console.info('[itemGiftCrawler] completed', {
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
      match_threshold_requested: requestedThreshold,
      match_threshold_used: thresholdUsed,
      sources_considered: candidates.length,
      sources_returned: top.length,
    },
    opportunityLogs: logs,
  }
}

export default processItemGiftCrawlerJob

