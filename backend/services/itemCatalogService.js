import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { buildProfileContext, buildProfileSignals } from './profileHelpers.js'

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

function scoreCatalogItem(item, signals) {
  const reasons = []
  const tokens = new Set(signals?.keywords ?? [])
  const tagTokens = new Set([...(item.tags || []), ...(item.synonyms || []), item.name].flatMap(tokenize))

  let overlap = 0
  for (const token of tagTokens) {
    if (!token || token.length < 3) continue
    if (tokens.has(token)) overlap += 1
  }

  // Base score keeps results inclusive; no hard filters based on missing profile fields.
  let score = 35 + Math.min(45, overlap * 8)

  // Applicant type boosts (soft)
  const applicantTypes = signals?.applicantTypes ? Array.from(signals.applicantTypes) : []
  const isStudent = applicantTypes.some((t) => String(t).includes('student'))
  if (isStudent && ['education', 'technology'].includes(String(item.category || ''))) {
    score += 10
    reasons.push('Student profile boost')
  }

  const assistance = signals?.assistance ? Array.from(signals.assistance) : []
  const hasDisabilitySignal =
    assistance.some((t) => String(t).includes('disabil')) ||
    (signals?.health ? Array.from(signals.health).some((t) => String(t).includes('disabil')) : false)
  if (hasDisabilitySignal && ['mobility', 'medical'].includes(String(item.category || ''))) {
    score += 10
    reasons.push('Disability/medical support boost')
  }

  if (overlap > 0) reasons.push(`Matches profile keywords (${overlap})`)

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
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

  // Safety: Never let low-signal discovered tokens crowd out useful suggestions.
  // - Prefer curated items
  // - Require higher score for anya_discovered items
  const curated = scoredAll.filter((s) => s.source !== 'anya_discovered' && s.score >= 40)
  const discovered = scoredAll.filter((s) => s.source === 'anya_discovered' && s.score >= 55)
  const merged = [...curated, ...discovered].sort((a, b) => b.score - a.score)

  // Fallback: if we still have too few, allow curated down to 0 score (but keep discovered gated).
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20))
  const candidateList =
    merged.length >= safeLimit
      ? merged
      : [...curated, ...scoredAll.filter((s) => s.source !== 'anya_discovered')]

  // De-dupe by name (safety: prevent duplicates when fallback extends the list)
  const seenNames = new Set()
  const finalList = []
  for (const entry of candidateList) {
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

