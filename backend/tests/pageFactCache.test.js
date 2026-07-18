/**
 * Phase 0.2 web-lane de-contamination — content-addressed page-fact cache.
 *
 * ADDITIVE, default-off, ZERO behavior change. These tests pin that:
 *   (a) computeCacheKey is deterministic + collision-resistant — identical
 *       components => identical key, and each differing component => a DIFFERENT
 *       key (the "same page => same facts" guarantee a later profile-blind
 *       extractor will rely on);
 *   (b) put-then-get round-trips the facts; a miss returns null; a row with
 *       MALFORMED stored JSON is treated as a miss (no throw);
 *   (c) the numbered migration creates the table on a fresh DB and is idempotent,
 *       and the boot schema invariant heals a DB that lacks the table; and
 *   (d) NOTHING in the live code path imports the accessor yet (zero behavior
 *       change — wired in Phase 1).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  computeCacheKey,
  getCachedPageFacts,
  putCachedPageFacts,
  CACHE_KEY_COMPONENTS,
  MAX_PAGE_FACTS_JSON_BYTES,
} from '../services/pageFactCache.js'
import { ensurePageFactCacheTable } from '../startup/ensureSchemaInvariants.js'

const sqlitePath = path.join(process.cwd(), 'backend/db/migrations/145_page_fact_cache.sql')
const pgPath = path.join(process.cwd(), 'backend/db/postgres/migrations/0149_page_fact_cache.sql')

// A DB whose page_fact_cache table was created by applying the ACTUAL migration
// file, so the accessor is exercised against the real shipped schema.
function makeMigratedDb() {
  const raw = new Database(':memory:')
  raw.exec(fs.readFileSync(sqlitePath, 'utf8'))
  raw.dialect = 'sqlite'
  return raw
}

const COMPONENTS = Object.freeze({
  normalizedFinalUrl: 'https://example.org/grant',
  contentHash: 'sha256:abc123',
  extractorVersion: 'v1',
  promptVersion: 'p1',
  model: 'claude-3',
})

describe('computeCacheKey — deterministic + collision-resistant', () => {
  it('is a 64-char lowercase hex SHA-256 digest', () => {
    expect(computeCacheKey(COMPONENTS)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('identical components => identical key (order of object keys irrelevant)', () => {
    const a = computeCacheKey(COMPONENTS)
    const b = computeCacheKey({
      model: 'claude-3',
      promptVersion: 'p1',
      extractorVersion: 'v1',
      contentHash: 'sha256:abc123',
      normalizedFinalUrl: 'https://example.org/grant',
    })
    expect(b).toBe(a)
  })

  it('EACH differing component produces a DIFFERENT key', () => {
    const base = computeCacheKey(COMPONENTS)
    for (const field of CACHE_KEY_COMPONENTS) {
      const changed = computeCacheKey({ ...COMPONENTS, [field]: `${COMPONENTS[field]}-CHANGED` })
      expect(changed, `changing ${field} must change the key`).not.toBe(base)
    }
  })

  it('REJECTS a non-string or empty component (throws) — the real contract', () => {
    // The contract is five non-empty STRINGS. Anything else must throw, NOT be
    // lossily coerced to a string before hashing (that is what let distinct
    // logical tuples collide onto one key and corrupt the cache via the upsert).
    for (const bad of [1, 0, false, true, null, undefined, {}, ['a', 'b'], '']) {
      for (const field of CACHE_KEY_COMPONENTS) {
        expect(
          () => computeCacheKey({ ...COMPONENTS, [field]: bad }),
          `component ${field}=${JSON.stringify(bad)} must throw`,
        ).toThrow(TypeError)
      }
    }
    // A missing (omitted) component also throws.
    expect(() =>
      computeCacheKey({
        normalizedFinalUrl: COMPONENTS.normalizedFinalUrl,
        contentHash: COMPONENTS.contentHash,
        extractorVersion: COMPONENTS.extractorVersion,
        promptVersion: COMPONENTS.promptVersion,
      }),
    ).toThrow(TypeError)
  })

  it('distinct STRING values that only LOOK alike do not collide (no lossy coercion)', () => {
    // These string pairs would have collided under the old String()-coercion of
    // 1/false/null: the string forms are legitimate distinct components and MUST
    // yield distinct keys. (The non-string originals now throw — asserted above.)
    const key = (model) => computeCacheKey({ ...COMPONENTS, model })
    expect(key('1')).not.toBe(key('true'))
    expect(key('false')).not.toBe(key('0'))
    expect(key('null')).not.toBe(key('undefined'))
    expect(key('[object Object]')).not.toBe(key('{}'))
    // All five above are also distinct from each other and from the base model.
    const keys = new Set(['1', 'true', 'false', '0', 'null', 'undefined', 'claude-3'].map(key))
    expect(keys.size).toBe(7)
  })

  it('cannot be collided by delimiter shuffling between components', () => {
    // Unambiguous serialization: moving text across a component boundary yields
    // a different key (a naive "join by delimiter" hash would collide these).
    const a = computeCacheKey({ ...COMPONENTS, normalizedFinalUrl: 'a', contentHash: 'bc' })
    const b = computeCacheKey({ ...COMPONENTS, normalizedFinalUrl: 'ab', contentHash: 'c' })
    expect(a).not.toBe(b)
  })
})

describe('get/put round-trip', () => {
  it('put then get returns the SAME facts', async () => {
    const db = makeMigratedDb()
    const key = computeCacheKey(COMPONENTS)
    const facts = { title: 'Grant A', amount_max: 20000, eligibility: ['students'], nested: { a: 1 } }
    expect(await putCachedPageFacts(db, key, COMPONENTS, facts)).toBe(true)
    expect(await getCachedPageFacts(db, key)).toEqual(facts)
  })

  it('persists the five components as their own columns (debuggability)', async () => {
    const db = makeMigratedDb()
    const key = computeCacheKey(COMPONENTS)
    await putCachedPageFacts(db, key, COMPONENTS, { ok: true })
    const row = db.prepare('SELECT * FROM page_fact_cache WHERE cache_key = ?').get(key)
    expect(row.normalized_final_url).toBe(COMPONENTS.normalizedFinalUrl)
    expect(row.content_hash).toBe(COMPONENTS.contentHash)
    expect(row.extractor_version).toBe(COMPONENTS.extractorVersion)
    expect(row.prompt_version).toBe(COMPONENTS.promptVersion)
    expect(row.model).toBe(COMPONENTS.model)
  })

  it('re-put of the same key refreshes facts but PRESERVES created_at', async () => {
    const db = makeMigratedDb()
    const key = computeCacheKey(COMPONENTS)
    await putCachedPageFacts(db, key, COMPONENTS, { v: 1 })
    const first = db.prepare('SELECT created_at FROM page_fact_cache WHERE cache_key = ?').get(key)
    await putCachedPageFacts(db, key, COMPONENTS, { v: 2 })
    const second = db.prepare('SELECT created_at, page_facts_json FROM page_fact_cache WHERE cache_key = ?').get(key)
    expect(await getCachedPageFacts(db, key)).toEqual({ v: 2 })
    expect(second.created_at).toBe(first.created_at)
    // Still exactly one row for the key.
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_fact_cache').get().n).toBe(1)
  })
})

describe('miss + corruption semantics', () => {
  it('an unknown key is a MISS (null)', async () => {
    const db = makeMigratedDb()
    expect(await getCachedPageFacts(db, computeCacheKey(COMPONENTS))).toBeNull()
  })

  it('a null/empty key is a MISS (null), never a throw', async () => {
    const db = makeMigratedDb()
    expect(await getCachedPageFacts(db, null)).toBeNull()
    expect(await getCachedPageFacts(db, '')).toBeNull()
  })

  it('MALFORMED stored JSON is treated as a MISS (null), never a throw', async () => {
    const db = makeMigratedDb()
    const key = 'deadbeef'
    // Write a row directly with un-parseable JSON in page_facts_json.
    db.prepare(
      `INSERT INTO page_fact_cache
        (cache_key, normalized_final_url, content_hash, extractor_version, prompt_version, model, page_facts_json)
       VALUES (?, '', '', '', '', '', ?)`,
    ).run(key, '{not valid json')
    // A throw here would fail the test — proving "never throws"; the result is a miss.
    const result = await getCachedPageFacts(db, key)
    expect(result).toBeNull()
  })
})

describe('size cap (per-value bound; table-level retention is a Phase 1 TODO)', () => {
  it('put REFUSES an over-cap payload (returns false, writes nothing)', async () => {
    const db = makeMigratedDb()
    const key = computeCacheKey(COMPONENTS)
    const huge = { blob: 'x'.repeat(MAX_PAGE_FACTS_JSON_BYTES + 100) }
    expect(await putCachedPageFacts(db, key, COMPONENTS, huge)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_fact_cache').get().n).toBe(0)
  })

  it('put ACCEPTS a payload at/under the cap', async () => {
    const db = makeMigratedDb()
    const key = computeCacheKey(COMPONENTS)
    const facts = { blob: 'y'.repeat(1000) }
    expect(await putCachedPageFacts(db, key, COMPONENTS, facts)).toBe(true)
    expect(await getCachedPageFacts(db, key)).toEqual(facts)
  })

  it('get treats an OVER-CAP stored row as a MISS (null), never a throw', async () => {
    const db = makeMigratedDb()
    const key = 'oversized'
    // Valid JSON, but past the cap — a defensive miss (the caller recomputes).
    const oversized = JSON.stringify({ blob: 'z'.repeat(MAX_PAGE_FACTS_JSON_BYTES + 100) })
    db.prepare(
      `INSERT INTO page_fact_cache
        (cache_key, normalized_final_url, content_hash, extractor_version, prompt_version, model, page_facts_json)
       VALUES (?, '', '', '', '', '', ?)`,
    ).run(key, oversized)
    expect(await getCachedPageFacts(db, key)).toBeNull()
  })
})

describe('migration 145 / pg 0149 — page_fact_cache table', () => {
  it('exists as a numbered twin pair', () => {
    expect(fs.existsSync(sqlitePath)).toBe(true)
    expect(fs.existsSync(pgPath)).toBe(true)
  })

  it('both twins use CREATE TABLE IF NOT EXISTS (naturally idempotent)', () => {
    expect(fs.readFileSync(sqlitePath, 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS page_fact_cache/)
    expect(fs.readFileSync(pgPath, 'utf8')).toMatch(/CREATE TABLE IF NOT EXISTS page_fact_cache/)
  })

  it('applies on a fresh DB AND is idempotent (re-run is a no-op)', () => {
    const raw = new Database(':memory:')
    const sql = fs.readFileSync(sqlitePath, 'utf8')
    expect(() => raw.exec(sql)).not.toThrow()
    // Re-running must be a clean no-op (CREATE TABLE IF NOT EXISTS).
    expect(() => raw.exec(sql)).not.toThrow()
    const t = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='page_fact_cache'`).get()
    expect(t?.name).toBe('page_fact_cache')
  })

  it('boot invariant ensurePageFactCacheTable heals a DB that lacks the table (idempotent)', async () => {
    const raw = new Database(':memory:')
    raw.dialect = 'sqlite'
    await ensurePageFactCacheTable(raw, { logger: { log() {}, warn() {}, error() {} } })
    // Idempotent second pass.
    await ensurePageFactCacheTable(raw, { logger: { log() {}, warn() {}, error() {} } })
    const key = computeCacheKey(COMPONENTS)
    await putCachedPageFacts(raw, key, COMPONENTS, { healed: true })
    expect(await getCachedPageFacts(raw, key)).toEqual({ healed: true })
  })
})

describe('zero behavior change — nothing live calls the accessor yet', () => {
  // Walk the live source dirs (NOT tests) for any import/require of the accessor
  // module. Doc-comment MENTIONS of the module path (schema.sql, the boot
  // invariant) are fine — those are the additive registration points, not
  // callers; we assert only that no live code IMPORTS/CALLS it (wired in Phase 1).
  const LIVE_DIRS = ['backend', 'src', 'shared']
  const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/
  const IMPORT_RE = /(?:from\s+['"][^'"]*pageFactCache|require\(\s*['"][^'"]*pageFactCache)/
  const CALL_RE = /\b(?:getCachedPageFacts|putCachedPageFacts|computeCacheKey)\s*\(/

  function walk(dir, out) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // Skip test directories/files — the accessor's OWN tests import it.
        if (ent.name === 'tests' || ent.name === '__tests__') continue
        walk(full, out)
      } else if (CODE_EXT.test(ent.name) && !/\.test\.|\.spec\./.test(ent.name)) {
        out.push(full)
      }
    }
    return out
  }

  it('no live source file imports OR calls the accessor (wired in Phase 1)', () => {
    const modulePath = 'backend/services/pageFactCache.js'
    const files = LIVE_DIRS.flatMap((d) => walk(path.join(process.cwd(), d), []))
    const offenders = []
    for (const f of files) {
      const rel = path.relative(process.cwd(), f).split(path.sep).join('/')
      if (rel === modulePath) continue // the module defines the functions
      const src = fs.readFileSync(f, 'utf8')
      if (IMPORT_RE.test(src) || CALL_RE.test(src)) offenders.push(rel)
    }
    expect(offenders, `unexpected live import/call of pageFactCache: ${offenders.join(', ')}`).toEqual([])
  })
})
