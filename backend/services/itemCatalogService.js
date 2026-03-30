import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { buildProfileContext, buildProfileSignals } from './profileHelpers.js'
import { getOpenAIOptional, invokeJsonWithFallback } from '../utils/aiProviders.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function safeJsonParse(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase()
}

function tokenize(text) {
  return normalizeLower(text)
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 40)
}

function loadFixtureCatalog() {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'crawlers', 'item_catalog.json')
  try {
    const raw = fs.readFileSync(fixturePath, 'utf8')
    const parsed = JSON.parse(raw)
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return items
  } catch (error) {
    console.warn('[itemCatalog] Failed to load fixture catalog', error?.message || String(error))
    return []
  }
}

export async function ensureItemCatalogSeeded(db) {
  if (!db) return { ok: false, error: 'db_unavailable' }
  try {
    const existing = await db.prepare('SELECT COUNT(*) as count FROM item_catalog').get()
    const count = Number(existing?.count ?? 0)
    if (count > 0) return { ok: true, skipped: true, reason: 'already_seeded', count }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }

  const items = loadFixtureCatalog()
  let inserted = 0
  for (const item of items) {
    const name = normalizeText(item?.name)
    if (!name) continue
    const synonyms = Array.isArray(item?.synonyms) ? item.synonyms : []
    const tags = Array.isArray(item?.tags) ? item.tags : []
    const category = item?.category ?? null
    const source = item?.source ?? 'curated'
    const evidenceUrl = item?.evidence_url ?? null
    const notes = item?.notes ?? null

    try {
      await db
        .prepare(
          `
            INSERT INTO item_catalog (
              id, name, category, synonyms, tags, source, evidence_url, notes, active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO NOTHING
          `,
        )
        .run(
          crypto.randomUUID(),
          name,
          category,
          JSON.stringify(synonyms),
          JSON.stringify(tags),
          source,
          evidenceUrl,
          notes,
          db?.dialect === 'postgres' ? true : 1,
        )
      inserted += 1
    } catch {
      // ignore duplicates / schema drift
    }
  }

  return { ok: true, inserted, seeded_from_fixture: true }
}

export async function listActiveCatalogItems(db, { limit = 500 } = {}) {
  const activePredicate = db?.dialect === 'postgres' ? 'active = TRUE' : 'active = 1'
  const rows = await db
    .prepare(
      `
        SELECT id, name, category, synonyms, tags, source, evidence_url, notes, active, updated_at
        FROM item_catalog
        WHERE ${activePredicate}
        ORDER BY category ASC, name ASC
        LIMIT ?
      `,
    )
    .all(limit)

  return (rows || []).map((row) => ({
    ...row,
    synonyms: safeJsonParse(row.synonyms, []),
    tags: safeJsonParse(row.tags, []),
    active: row.active === true || row.active === 1,
  }))
}

// Map from catalog item category to the signal needs that qualify it for display.
const CATEGORY_NEED_REQUIREMENTS = {
  mobility: ['disability'],
  medical: ['disability', 'healthcare'],
  employment: ['employment'],
  education: ['education', 'scholarship'],
  technology: ['internet', 'education', 'employment', 'business'],
  business: ['business', 'employment'],
  housing: ['housing'],
  food: ['food'],
  transportation: ['transportation', 'disability'],
  legal: ['legal'],
  financial: ['cash_assistance', 'employment', 'business'],
}

// Medical/mobility items that require a *specific* health signal (not just a generic need).
// If an item matches one of these patterns but the profile lacks the required health signal,
// the item scores 0 and is not shown.
const MEDICAL_SPECIFIC_REQUIREMENTS = [
  { namePattern: /hearing|deaf/i, requiredHealth: ['hearing_impairment'] },
  { namePattern: /vision|glass|eye/i, requiredHealth: ['visual_impairment'] },
  { namePattern: /wheelchair|wheel chair/i, requiredHealth: ['physical_disability', 'disability'] },
  { namePattern: /adaptive.*van|wheelchair.*van|handicap.*van/i, requiredHealth: ['physical_disability', 'disability'] },
]

function scoreCatalogItem(item, signals) {
  const reasons = []

  // Normalize signal sets (may arrive as Set objects or plain arrays)
  const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []))
  const tokens = new Set(signals?.keywords ?? [])
  const signalNeeds = toSet(signals?.needs)
  const healthSignals = toSet(signals?.health)
  const intentPhrases = toSet(signals?.intentPhrases)
  const occupationSignals = toSet(signals?.occupation)

  // Start at 0 — items must earn their score through signal relevance.
  let score = 0

  const category = String(item.category || '').toLowerCase()
  const requiredNeeds = CATEGORY_NEED_REQUIREMENTS[category] ?? []
  const categoryNeedMatch = requiredNeeds.some((need) => signalNeeds.has(need))
  const isMedicalOrMobility = category === 'medical' || category === 'mobility'

  if (isMedicalOrMobility) {
    // Medical/mobility items are gated behind specific health conditions.
    const itemText = [item.name, ...(item.synonyms ?? [])].join(' ')
    let specificReq = null
    for (const req of MEDICAL_SPECIFIC_REQUIREMENTS) {
      if (req.namePattern.test(itemText)) {
        specificReq = req
        break
      }
    }
    if (specificReq) {
      // Only display if the profile has the matching health signal.
      const matchedSignal = specificReq.requiredHealth.find((h) => healthSignals.has(h))
      if (matchedSignal) {
        score += 60
        reasons.push(`Health condition match: ${matchedSignal}`)
      }
      // If the pattern matched but the health signal is absent, score stays 0.
    } else if (categoryNeedMatch) {
      // Generic medical/mobility item without a specific pattern — show if the
      // profile has a matching disability or healthcare need.
      score += 45
      reasons.push(`Category "${category}" matches profile need`)
    }
  } else if (categoryNeedMatch) {
    score += 50
    const matchedNeeds = requiredNeeds.filter((n) => signalNeeds.has(n))
    reasons.push(`Category "${category}" matches: ${matchedNeeds.join(', ')}`)
  }

  // Keyword overlap: bonus when there is already a category match; standalone only
  // when the overlap is very strong (≥3 tokens).
  const tagTokens = new Set([...(item.tags || []), ...(item.synonyms || []), item.name].flatMap(tokenize))
  let overlap = 0
  for (const token of tagTokens) {
    if (!token || token.length < 3) continue
    if (tokens.has(token)) overlap += 1
  }
  if (overlap > 0) {
    if (score > 0) {
      score += Math.min(20, overlap * 8)
      reasons.push(`Keyword overlap (${overlap})`)
    } else if (overlap >= 3) {
      score += Math.min(30, overlap * 8)
      reasons.push(`Strong keyword match (${overlap})`)
    }
  }

  // Intent phrase matching: goal phrases (e.g. "food truck business") boost items
  // whose name/tags/synonyms share at least two significant words with the phrase.
  const intentArr = Array.from(intentPhrases)
  if (intentArr.length > 0) {
    const allItemText = [item.name, ...(item.tags ?? []), ...(item.synonyms ?? [])].join(' ').toLowerCase()
    for (const phrase of intentArr) {
      if (!phrase) continue
      const phraseWords = String(phrase).split(/\s+/).filter((w) => w.length >= 3)
      const matchCount = phraseWords.filter((w) => allItemText.includes(w)).length
      if (matchCount >= 2 || (matchCount >= 1 && phraseWords.length <= 2)) {
        score += 25
        reasons.push('Matches goal phrase')
        break
      }
    }
  }

  // Applicant type boosts (soft)
  const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []
  if (applicantTypes.some((t) => String(t).includes('student')) && ['education', 'technology'].includes(category)) {
    score += 15
    reasons.push('Student profile boost')
  }

  // Employment/occupation boost
  if (category === 'employment' && occupationSignals.size > 0 && score > 0) {
    score += 10
    reasons.push('Occupation signals present')
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
  }
}

// ---------------------------------------------------------------------------
// AI-powered need inference
// ---------------------------------------------------------------------------

// Simple in-memory cache: avoids repeated AI calls for the same profile goal.
const _aiInferenceCache = new Map()
const AI_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const AI_CACHE_MAX_SIZE = 100

// Score assigned to AI-inferred items; high enough to surface above catalog matches
// but below items with direct health-signal matches (which score 60+).
const AI_INFERRED_BASE_SCORE = 75

function _getCachedAIResult(cacheKey) {
  const entry = _aiInferenceCache.get(cacheKey)
  if (!entry) return null
  if (Date.now() - entry.timestamp > AI_CACHE_TTL_MS) {
    _aiInferenceCache.delete(cacheKey)
    return null
  }
  return entry.items
}

function _setCachedAIResult(cacheKey, items) {
  // Purge expired entries before evicting by size to favour TTL-based cleanup.
  if (_aiInferenceCache.size >= AI_CACHE_MAX_SIZE) {
    const now = Date.now()
    for (const [k, v] of _aiInferenceCache) {
      if (now - v.timestamp > AI_CACHE_TTL_MS) _aiInferenceCache.delete(k)
    }
    // If still full after TTL purge, remove the oldest entry (FIFO).
    if (_aiInferenceCache.size >= AI_CACHE_MAX_SIZE) {
      const firstKey = _aiInferenceCache.keys().next().value
      _aiInferenceCache.delete(firstKey)
    }
  }
  _aiInferenceCache.set(cacheKey, { items, timestamp: Date.now() })
}

async function inferNeedsWithAI(signals, profileContext) {
  const profile = profileContext?.profile ?? {}
  const comprehensive = profileContext?.sections?.comprehensive_application ?? {}

  const goalText = [
    profile.primary_goal,
    comprehensive.primary_goal,
    comprehensive.mission,
    comprehensive.career_goal,
    comprehensive.use_of_funds,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()

  const intentPhrases = Array.from(signals?.intentPhrases ?? []).join('; ')
  const detectedNeeds = Array.from(signals?.needs ?? []).join(', ')

  if (!goalText && !intentPhrases) return []

  // Cache key combines goal text and intent phrases
  const cacheKey = `${goalText}||${intentPhrases}`
  const cached = _getCachedAIResult(cacheKey)
  if (cached) return cached

  const openai = getOpenAIOptional()
  const contextSummary = goalText || intentPhrases

  const systemPrompt =
    'You are a needs assessment specialist helping identify what specific items, resources, or services a person requires to accomplish their goals.'

  const userPrompt =
    `Profile goal/narrative: "${contextSummary}"\n` +
    `Detected need categories: ${detectedNeeds || 'none'}\n\n` +
    `List 6–8 specific items or resources this person needs to accomplish their stated goals.\n` +
    `Focus ONLY on what is clearly relevant. Do NOT include generic or unrelated items (e.g. do not suggest hearing aids for a food-truck entrepreneur).\n\n` +
    `Return JSON: { "items": [{ "name": "Item Name", "category": "category", "reason": "one-sentence reason" }] }\n` +
    `Valid categories: business, employment, education, technology, mobility, medical, food, housing, transportation, legal, financial`

  try {
    const result = await invokeJsonWithFallback({
      openai,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.2,
      maxTokens: 600,
    })

    if (!result.ok || !result.json) return []

    const rawItems = result.json?.items
    if (!Array.isArray(rawItems)) return []

    const items = rawItems
      .filter((item) => item?.name && typeof item.name === 'string')
      .map((item) => ({
        name: String(item.name).trim(),
        category: String(item.category || 'general').toLowerCase(),
        score: AI_INFERRED_BASE_SCORE, // AI-inferred items start with a high relevance score
        reasons: [item.reason ? String(item.reason).trim() : 'AI-inferred from profile goals'],
        source: 'ai_inferred',
      }))

    _setCachedAIResult(cacheKey, items)
    return items
  } catch (err) {
    console.warn('[itemCatalog] AI inference error', err?.message || err)
    return []
  }
}

export async function suggestItemsForProfile(db, { profileId, limit = 8 } = {}) {
  if (!profileId) {
    const err = new Error('profile_id required')
    err.statusCode = 400
    throw err
  }

  // Ensure baseline catalog exists
  await ensureItemCatalogSeeded(db)

  const profileContext = await buildProfileContext(db, String(profileId))
  const signals = buildProfileSignals({
    profile: profileContext?.profile ?? null,
    sections: profileContext?.sections ?? {},
  })

  // 1. Score catalog items using the profile's actual signals
  const catalog = await listActiveCatalogItems(db, { limit: 500 })
  const scoredAll = catalog
    .map((item) => {
      const scoredItem = scoreCatalogItem(item, signals)
      return {
        name: item.name,
        category: item.category ?? null,
        score: scoredItem.score,
        reasons: scoredItem.reasons,
        source: item.source ?? 'curated',
      }
    })
    .sort((a, b) => b.score - a.score)

  // Only surface items that have meaningful signal overlap.
  // Discovered items are held to a higher bar to prevent noise.
  const curated = scoredAll.filter((s) => s.source !== 'anya_discovered' && s.score >= 40)
  const discovered = scoredAll.filter((s) => s.source === 'anya_discovered' && s.score >= 55)
  const catalogMatches = [...curated, ...discovered].sort((a, b) => b.score - a.score)

  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20))

  // 2. AI-powered need inference from goal/intent fields.
  // Runs when the profile has narrative or goal content so that goal-specific items
  // (e.g. "food truck", "business license") can supplement the static catalog.
  let aiItems = []
  try {
    const profile = profileContext?.profile ?? {}
    const comprehensive = profileContext?.sections?.comprehensive_application ?? {}
    const hasGoalContent = Boolean(
      profile.primary_goal ||
        comprehensive.primary_goal ||
        comprehensive.mission ||
        comprehensive.career_goal ||
        comprehensive.use_of_funds ||
        (signals.intentPhrases && signals.intentPhrases.size > 0),
    )
    if (hasGoalContent) {
      aiItems = await inferNeedsWithAI(signals, profileContext)
    }
  } catch (err) {
    console.warn('[itemCatalog] AI inference failed, using catalog only', err?.message)
  }

  // 3. Merge catalog + AI results (catalog first for curated quality), then de-dupe
  const allCandidates = [...catalogMatches, ...aiItems]

  const seenNames = new Set()
  const finalList = []
  for (const entry of allCandidates) {
    if (!entry?.name) continue
    const key = normalizeLower(entry.name)
    if (!key || seenNames.has(key)) continue
    seenNames.add(key)
    finalList.push(entry)
    if (finalList.length >= safeLimit) break
  }

  return {
    profile_id: String(profileId),
    count: finalList.length,
    suggestions: finalList,
    generated_at: new Date().toISOString(),
  }
}

const STOPWORDS = new Set([
  'and','the','for','with','from','your','their','this','that','these','those','into','onto','over','under','about','need','needs','help','support',
  'grant','grants','funding','funds','program','programs','donation','donations','apply','application','available','eligibility','eligible',
  // Not items (generic)
  'assistance','local','community','directory','emergency','housing','services','service','resources','resource',
  // Not items (people/attributes)
  'veteran','disabled','single','parent','individual','student','nonprofit','organization',
  'students',
  // Not items (generic item-gift terms)
  'item','items','gift','kind','in','inkind','in-kind','donated','donate',
  'technology',
])

function looksLikeItemToken(token) {
  if (!token) return false
  if (token.length < 4) return false
  if (token.length > 32) return false
  if (STOPWORDS.has(token)) return false
  if (/^\d+$/.test(token)) return false
  return true
}

export async function discoverNewCatalogItems(db, { minCount = 3, limit = 50 } = {}) {
  // Deterministic, reversible discovery: scan opportunity keywords and propose new items.
  // NOTE: This does NOT scrape the web. It only uses already-ingested DB content.
  await ensureItemCatalogSeeded(db)

  // Clean up previously discovered noise (reversible: set active=false).
  // IMPORTANT: Earlier heuristic versions could insert non-item tokens (locations, attributes).
  // We deactivate anything that fails our "item-like" checks or was discovered from non-item sources.
  try {
    const inactiveValue = db?.dialect === 'postgres' ? false : 0
    const activePredicate = db?.dialect === 'postgres' ? 'active = TRUE' : 'active = 1'
    const allowedDiscoverySources = new Set(['item_gift', 'item_funding'])

    const rows = await db
      .prepare(
        `
          SELECT id, name, notes
          FROM item_catalog
          WHERE source = 'anya_discovered'
            AND ${activePredicate}
          ORDER BY updated_at DESC
          LIMIT 800
        `,
      )
      .all()

    let deactivated = 0
    for (const row of rows || []) {
      const name = normalizeText(row?.name)
      const token = normalizeLower(name)
      const notes = safeJsonParse(row?.notes, null)
      const discoveredSource = notes?.discovered_from?.source ?? null

      const shouldDeactivate =
        !name ||
        STOPWORDS.has(token) ||
        (!looksLikeItemToken(token) && !token.includes(' ')) ||
        (discoveredSource && !allowedDiscoverySources.has(String(discoveredSource)))

      if (!shouldDeactivate) continue

      try {
        await db
          .prepare(
            `
              UPDATE item_catalog
              SET active = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
          )
          .run(inactiveValue, String(row.id))
        deactivated += 1
      } catch {
        // ignore per-row
      }
    }

    if (deactivated > 0) {
      console.info('[itemCatalog] deactivated noisy discovered items', { count: deactivated })
    }
  } catch {
    // best-effort cleanup
  }

  const existingRows = await db.prepare('SELECT name FROM item_catalog').all()
  const existing = new Set((existingRows || []).map((r) => normalizeLower(r.name)).filter(Boolean))

  // Only mine item-focused sources to avoid importing locations/attributes from general directories.
  const activePredicate = db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1'
  const rows = await db
    .prepare(
      `
        SELECT id, title, source, keywords, updated_at
        FROM funding_opportunities
        WHERE ${activePredicate}
          AND source IN ('item_gift', 'item_funding')
        ORDER BY updated_at DESC
        LIMIT 800
      `,
    )
    .all()

  const counts = new Map()
  const example = new Map()

  for (const row of rows || []) {
    const kws = safeJsonParse(row.keywords, [])
    const keywordEntries = Array.isArray(kws) ? kws : []

    for (const entry of keywordEntries) {
      const raw = normalizeText(entry)
      if (!raw) continue

      // Prefer phrases when present (e.g. "wheelchair van", "handicap van")
      if (raw.includes(' ')) {
        const phrase = raw.toLowerCase().trim()
        if (phrase.length >= 5 && phrase.length <= 40 && !STOPWORDS.has(phrase)) {
          counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
          if (!example.has(phrase)) {
            example.set(phrase, { opportunity_id: row.id, title: row.title, source: row.source ?? null })
          }
        }
        continue
      }

      // Single-word tokens
      const token = raw.toLowerCase()
      if (!looksLikeItemToken(token)) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
      if (!example.has(token)) {
        example.set(token, { opportunity_id: row.id, title: row.title, source: row.source ?? null })
      }
    }
  }

  const candidates = Array.from(counts.entries())
    .filter(([, c]) => c >= Math.max(1, Number(minCount) || 3))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))

  let inserted = 0
  const insertedItems = []
  for (const [token, count] of candidates) {
    if (existing.has(token)) continue
    const ex = example.get(token) ?? null
    const name = token.replace(/\b\w/g, (m) => m.toUpperCase())

    try {
      await db
        .prepare(
          `
            INSERT INTO item_catalog (
              id, name, category, synonyms, tags, source, evidence_url, notes, active, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(name) DO NOTHING
          `,
        )
        .run(
          crypto.randomUUID(),
          name,
          null,
          JSON.stringify([token]),
          JSON.stringify(['anya_discovered']),
          'anya_discovered',
          null,
          JSON.stringify({ discovered_from: ex, observed_count: count }),
          db?.dialect === 'postgres' ? true : 1,
        )

      inserted += 1
      insertedItems.push({ name, token, observed_count: count, discovered_from: ex })
      existing.add(token)
    } catch {
      // ignore
    }
  }

  const report = {
    ok: true,
    inserted,
    scanned_opportunities: (rows || []).length,
    min_count: Math.max(1, Number(minCount) || 3),
    generated_at: new Date().toISOString(),
    items: insertedItems.slice(0, 50),
  }
  console.info('[itemCatalog] discovery report', report)
  return report
}

