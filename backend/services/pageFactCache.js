// backend/services/pageFactCache.js
//
// Phase 0.2 of the web-lane de-contamination program: a CONTENT-ADDRESSED
// page-fact cache. A LATER phase's profile-blind extractor will use this to get
// a deterministic "same page => same facts" guarantee and reuse an extraction
// across profiles instead of re-calling the LLM.
//
// ADDITIVE, default-off: NOTHING in the live code path calls this module yet —
// it is wired in Phase 1. This file adds ONLY the pure key function + injectable
// DB accessors over the `page_fact_cache` table (migration 145 / pg 0149).
//
// Design:
//   - `computeCacheKey` is a pure, stable, collision-resistant hash of the five
//     content-addressing components. Identical components => identical key; any
//     differing component => a different key. It does NO I/O.
//   - `getCachedPageFacts` / `putCachedPageFacts` take an injectable `db` (the
//     repo's dialect-agnostic shim; `?` placeholders + `ON CONFLICT ... DO
//     UPDATE` work on both SQLite and Postgres).
//   - JSON is validated on READ: malformed stored JSON is treated as a cache
//     MISS (returns null), never a throw — a cache miss is a safe outcome
//     (the caller recomputes).

import crypto from 'node:crypto'

/**
 * The five content-addressing components, in canonical order. The cache_key is
 * derived from exactly these — changing this list changes every key, so it is
 * the single source of truth for both the hash input and the stored columns.
 */
export const CACHE_KEY_COMPONENTS = Object.freeze([
  'normalizedFinalUrl',
  'contentHash',
  'extractorVersion',
  'promptVersion',
  'model',
])

/**
 * Coerce a component to a stable string. Nullish => '' so a missing component
 * hashes and stores deterministically (never null, never "undefined").
 */
function coerceComponent(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Compute the content-addressed cache key from its components.
 *
 * Stable + collision-resistant: the components are coerced to strings, ordered
 * canonically, serialized UNAMBIGUOUSLY via JSON.stringify of an array (so a
 * delimiter appearing inside one component cannot collide with another
 * arrangement), and hashed with SHA-256. Pure — no I/O.
 *
 * @param {{normalizedFinalUrl?, contentHash?, extractorVersion?, promptVersion?, model?}} components
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 */
export function computeCacheKey(components = {}) {
  const ordered = CACHE_KEY_COMPONENTS.map((field) => coerceComponent(components?.[field]))
  const canonical = JSON.stringify(ordered)
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Look up cached page facts by key.
 *
 * @param {*} db injectable dialect-agnostic DB shim.
 * @param {string} cacheKey the key from computeCacheKey().
 * @returns {Promise<object|null>} the parsed facts, or null on a miss (no row,
 *   or stored JSON that fails to parse — a corrupt entry is a miss, not a throw).
 */
export async function getCachedPageFacts(db, cacheKey) {
  if (!db || !cacheKey) return null
  const row = await db
    .prepare('SELECT page_facts_json FROM page_fact_cache WHERE cache_key = ? LIMIT 1')
    .get(String(cacheKey))
  if (!row || row.page_facts_json === null || row.page_facts_json === undefined) return null
  try {
    return JSON.parse(row.page_facts_json)
  } catch {
    // Malformed stored JSON => treat as a cache MISS, never throw.
    return null
  }
}

/**
 * Store page facts under a key. Upserts: a re-put of the same key refreshes the
 * facts but preserves the original created_at. The five components are persisted
 * as their own columns purely for debuggability (the cache_key is the identity).
 *
 * @param {*} db injectable dialect-agnostic DB shim.
 * @param {string} cacheKey the key from computeCacheKey().
 * @param {object} components the same components the key was derived from.
 * @param {*} facts JSON-serializable facts (nullish stores as JSON null).
 * @returns {Promise<boolean>} true when a row was written.
 */
export async function putCachedPageFacts(db, cacheKey, components = {}, facts) {
  if (!db || !cacheKey) return false
  const pageFactsJson = JSON.stringify(facts === undefined ? null : facts)
  await db
    .prepare(
      `INSERT INTO page_fact_cache
         (cache_key, normalized_final_url, content_hash, extractor_version, prompt_version, model, page_facts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET page_facts_json = excluded.page_facts_json`,
    )
    .run(
      String(cacheKey),
      coerceComponent(components?.normalizedFinalUrl),
      coerceComponent(components?.contentHash),
      coerceComponent(components?.extractorVersion),
      coerceComponent(components?.promptVersion),
      coerceComponent(components?.model),
      pageFactsJson,
    )
  return true
}
