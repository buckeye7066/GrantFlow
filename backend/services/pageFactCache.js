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
// RETENTION / EVICTION (Phase 1 TODO): `page_fact_cache` is currently UNBOUNDED
// — this PR adds no eviction, TTL, or age sweep. Before sustained LIVE use a
// retention policy (age-based prune keyed on created_at and/or a row cap) MUST
// be added or the table grows without limit. The per-value cap below
// (MAX_PAGE_FACTS_JSON_BYTES) bounds ONE row's payload only, not the table.
//
// Design:
//   - `computeCacheKey` is a pure, INJECTIVE hash of the five content-addressing
//     components. Each component MUST be a non-empty string (the real contract:
//     a normalized URL, a content hash, version tags, and a model name are all
//     strings; Phase 1 passes strings) and the function THROWS otherwise. It
//     does NO lossy coercion before hashing, so distinct component tuples can
//     never collide onto one key — a collision plus the upsert below would let
//     one page's facts overwrite another's (cache corruption).
//   - `getCachedPageFacts` / `putCachedPageFacts` take an injectable `db` (the
//     repo's dialect-agnostic shim; `?` placeholders + `ON CONFLICT ... DO
//     UPDATE` work on both SQLite and Postgres).
//   - JSON is validated on READ: malformed OR oversized stored JSON is treated
//     as a cache MISS (returns null), never a throw — a miss is a safe outcome
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
 * Hard cap on a single stored page-facts payload (1 MiB). Extracted page facts
 * are a handful of small fields; anything larger is a bug or abuse. put refuses
 * to store beyond this; get treats an over-cap stored row as a miss. This bounds
 * ONE row — see the RETENTION note above for the (Phase 1) table-level policy.
 */
export const MAX_PAGE_FACTS_JSON_BYTES = 1024 * 1024

/**
 * Compute the content-addressed cache key from its components.
 *
 * INJECTIVE + collision-resistant. Every component MUST be a non-empty string
 * (throws a clear TypeError otherwise). The raw strings are ordered canonically,
 * serialized UNAMBIGUOUSLY via JSON.stringify of an array (which escapes quotes
 * and backslashes, so no character inside one component can masquerade as a
 * boundary), and hashed with SHA-256. No pre-coercion, no join-by-delimiter, so
 * distinct component tuples always yield distinct keys. Pure — no I/O.
 *
 * @param {{normalizedFinalUrl:string, contentHash:string, extractorVersion:string, promptVersion:string, model:string}} components
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 * @throws {TypeError} if any component is missing, empty, or not a string.
 */
export function computeCacheKey(components = {}) {
  const ordered = CACHE_KEY_COMPONENTS.map((field) => {
    const value = components?.[field]
    if (typeof value !== 'string' || value.length === 0) {
      const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      throw new TypeError(
        `computeCacheKey: component "${field}" must be a non-empty string (received ${got})`,
      )
    }
    return value
  })
  const canonical = JSON.stringify(ordered)
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Coerce a component to a string for the debuggability COLUMNS only (never the
 * key). By the time put is called the components were already validated as
 * non-empty strings by computeCacheKey; this is a defensive no-op on strings
 * that also keeps the NOT NULL columns satisfied.
 */
function coerceComponentColumn(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Look up cached page facts by key.
 *
 * @param {*} db injectable dialect-agnostic DB shim.
 * @param {string} cacheKey the key from computeCacheKey().
 * @returns {Promise<object|null>} the parsed facts, or null on a miss (no row,
 *   or stored JSON that is malformed OR over the size cap — a corrupt/oversized
 *   entry is a miss, not a throw).
 */
export async function getCachedPageFacts(db, cacheKey) {
  if (!db || !cacheKey) return null
  const row = await db
    .prepare('SELECT page_facts_json FROM page_fact_cache WHERE cache_key = ? LIMIT 1')
    .get(String(cacheKey))
  if (!row || row.page_facts_json === null || row.page_facts_json === undefined) return null
  const raw = row.page_facts_json
  // Oversized stored payload => treat as a MISS (defensive; the caller recomputes).
  if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > MAX_PAGE_FACTS_JSON_BYTES) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    // Malformed stored JSON => treat as a cache MISS, never throw.
    return null
  }
}

/**
 * Store page facts under a key. Upserts: a re-put of the same key refreshes the
 * facts but preserves the original created_at. The five components are persisted
 * as their own columns purely for debuggability (the cache_key is the identity).
 * Refuses (returns false) to store a payload larger than MAX_PAGE_FACTS_JSON_BYTES.
 *
 * @param {*} db injectable dialect-agnostic DB shim.
 * @param {string} cacheKey the key from computeCacheKey().
 * @param {object} components the same components the key was derived from.
 * @param {*} facts JSON-serializable facts (nullish stores as JSON null).
 * @returns {Promise<boolean>} true when a row was written, false when skipped.
 */
export async function putCachedPageFacts(db, cacheKey, components = {}, facts) {
  if (!db || !cacheKey) return false
  const pageFactsJson = JSON.stringify(facts === undefined ? null : facts)
  if (Buffer.byteLength(pageFactsJson, 'utf8') > MAX_PAGE_FACTS_JSON_BYTES) return false
  await db
    .prepare(
      `INSERT INTO page_fact_cache
         (cache_key, normalized_final_url, content_hash, extractor_version, prompt_version, model, page_facts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET page_facts_json = excluded.page_facts_json`,
    )
    .run(
      String(cacheKey),
      coerceComponentColumn(components?.normalizedFinalUrl),
      coerceComponentColumn(components?.contentHash),
      coerceComponentColumn(components?.extractorVersion),
      coerceComponentColumn(components?.promptVersion),
      coerceComponentColumn(components?.model),
      pageFactsJson,
    )
  return true
}
