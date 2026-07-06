/**
 * Unit tests for backend/services/embeddings/embeddingService.js
 *
 * Proves the semantic-recall contract:
 *   1. cosineSimilarity is mathematically correct and never throws on junk.
 *   2. embedText degrades to null with no API key (feature no-ops cleanly).
 *   3. Vector serialization round-trips; corrupt payloads parse to null.
 *   4. augmentCandidatesWithSemanticRecall is ADDITIVE-ONLY: keyword rows are
 *      always a prefix of the result, in order, regardless of flag state.
 *   5. Semantic retrieval respects the caller's isolation WHERE fragment —
 *      profile B's private rows can never surface for profile A.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  cosineSimilarity,
  serializeVector,
  parseVector,
  buildOpportunityEmbeddingText,
  buildProfileEmbeddingText,
  embedText,
  isSemanticRecallEnabled,
  upsertOpportunityEmbedding,
  nearestOpportunitiesByVector,
  augmentCandidatesWithSemanticRecall,
} from '../services/embeddings/embeddingService.js'

const savedEnv = {}
function setEnv(key, value) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key]
})

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10)
  })

  it('scales invariantly (direction only)', () => {
    expect(cosineSimilarity([2, 4], [1, 2])).toBeCloseTo(1, 10)
  })

  it('returns 0 (never throws) on junk: mismatched lengths, empties, NaN, zero vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity(null, [1])).toBe(0)
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('vector serialization', () => {
  it('round-trips', () => {
    const vec = [0.25, -0.5, 1]
    expect(parseVector(serializeVector(vec))).toEqual(vec)
  })

  it('parses corrupt/empty payloads to null', () => {
    expect(parseVector('not json')).toBeNull()
    expect(parseVector('{}')).toBeNull()
    expect(parseVector('[]')).toBeNull()
    expect(parseVector(null)).toBeNull()
    expect(serializeVector([])).toBeNull()
    expect(serializeVector('nope')).toBeNull()
  })
})

describe('embedding text builders', () => {
  it('includes title/sponsor/description and parses JSON-string list columns', () => {
    const text = buildOpportunityEmbeddingText({
      title: 'Rural Fire Equipment Grant',
      sponsor: 'FEMA',
      description: 'Funds SCBA gear',
      categories: '["fire","safety"]',
      keywords: ['vfd'],
      state: 'TN',
    })
    expect(text).toContain('Rural Fire Equipment Grant')
    expect(text).toContain('FEMA')
    expect(text).toContain('fire safety')
    expect(text).toContain('vfd')
    expect(text).toContain('state:TN')
  })

  it('returns empty string for empty input and never throws', () => {
    expect(buildOpportunityEmbeddingText(null)).toBe('')
    expect(buildProfileEmbeddingText(null)).toBe('')
  })

  it('folds crawler-OS thesis signals into the profile text', () => {
    const text = buildProfileEmbeddingText(
      { name: 'Anytown VFD', state: 'TN' },
      { applicant_types: ['vfd'], needs: ['equipment'], keywords: [], interest_terms: [] },
    )
    expect(text).toContain('Anytown VFD')
    expect(text).toContain('vfd')
    expect(text).toContain('equipment')
  })
})

describe('graceful degradation without an API key', () => {
  it('embedText resolves null when OPENAI_API_KEY is absent', async () => {
    setEnv('OPENAI_API_KEY', undefined)
    await expect(embedText('anything')).resolves.toBeNull()
  })

  it('feature flag defaults OFF', () => {
    setEnv('SEMANTIC_RECALL', undefined)
    expect(isSemanticRecallEnabled()).toBe(false)
    setEnv('SEMANTIC_RECALL', '1')
    expect(isSemanticRecallEnabled()).toBe(true)
  })
})

// ── DB-backed retrieval tests ────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      record_origin TEXT,
      is_active INTEGER DEFAULT 1,
      profile_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE opportunity_embeddings (
      opportunity_id TEXT PRIMARY KEY REFERENCES funding_opportunities(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

async function seedOpp(db, { id, title, profileId = null, vector = null }) {
  db.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, source, record_origin, is_active, profile_id)
     VALUES (?, ?, 'Sponsor', 'test', 'curated_verified', 1, ?)`,
  ).run(id, title, profileId)
  if (vector) await upsertOpportunityEmbedding(db, id, vector)
}

const ISOLATION_WHERE = 'fo.is_active = 1 AND (fo.profile_id IS NULL OR fo.profile_id = ?)'

describe('nearestOpportunitiesByVector (profile isolation)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it("never surfaces another profile's private rows", async () => {
    await seedOpp(db, { id: 'global-1', title: 'Global grant', vector: [1, 0, 0] })
    await seedOpp(db, { id: 'a-private', title: 'Profile A private', profileId: 'profile-a', vector: [0.9, 0.1, 0] })
    await seedOpp(db, { id: 'b-private', title: 'Profile B private', profileId: 'profile-b', vector: [1, 0, 0] })

    const results = await nearestOpportunitiesByVector(db, {
      queryVector: [1, 0, 0],
      whereSql: ISOLATION_WHERE,
      whereParams: ['profile-a'],
      topK: 10,
    })
    const ids = results.map((r) => r.id)
    expect(ids).toContain('global-1')
    expect(ids).toContain('a-private')
    // profile B's row is the CLOSEST vector — isolation must still exclude it
    expect(ids).not.toContain('b-private')
  })

  it('ranks by cosine similarity and honors topK + excludeIds', async () => {
    await seedOpp(db, { id: 'near', title: 'Near', vector: [1, 0, 0] })
    await seedOpp(db, { id: 'mid', title: 'Mid', vector: [0.7, 0.7, 0] })
    await seedOpp(db, { id: 'far', title: 'Far', vector: [0, 0, 1] })

    const results = await nearestOpportunitiesByVector(db, {
      queryVector: [1, 0, 0],
      whereSql: ISOLATION_WHERE,
      whereParams: [null],
      topK: 2,
      excludeIds: new Set(['near']),
    })
    expect(results.map((r) => r.id)).toEqual(['mid'])
    expect(results[0].semantic_similarity).toBeGreaterThan(0)
    // 'far' is orthogonal (similarity 0) → filtered; 'near' excluded.
  })

  it('returns [] (never throws) when the embeddings table is missing', async () => {
    const bare = new Database(':memory:')
    bare.exec('CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, is_active INTEGER, profile_id TEXT)')
    const results = await nearestOpportunitiesByVector(bare, {
      queryVector: [1, 0],
      whereSql: ISOLATION_WHERE,
      whereParams: [null],
    })
    expect(results).toEqual([])
  })
})

describe('augmentCandidatesWithSemanticRecall (additive-only invariant)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('returns keyword rows untouched when the flag is OFF', async () => {
    setEnv('SEMANTIC_RECALL', undefined)
    const keywordRows = [{ id: 'k1', title: 'Keyword hit' }]
    const { rows, meta } = await augmentCandidatesWithSemanticRecall(db, {
      keywordRows,
      queryText: 'anything',
      whereSql: ISOLATION_WHERE,
      whereParams: [null],
    })
    expect(rows).toEqual(keywordRows)
    expect(meta.enabled).toBe(false)
    expect(meta.semantic_added).toBe(0)
  })

  it('NEVER removes or reorders keyword rows — they are a prefix of the result', async () => {
    setEnv('SEMANTIC_RECALL', '1')
    await seedOpp(db, { id: 'k1', title: 'Keyword hit', vector: [0, 1, 0] })
    await seedOpp(db, { id: 's1', title: 'Semantic-only hit', vector: [1, 0, 0] })
    const keywordRows = [{ id: 'k1', title: 'Keyword hit' }, { id: 'k2-not-embedded', title: 'Keyword only' }]

    const { rows, meta } = await augmentCandidatesWithSemanticRecall(db, {
      keywordRows,
      queryText: 'fire equipment',
      whereSql: ISOLATION_WHERE,
      whereParams: [null],
      _embedText: async () => [1, 0, 0],
    })

    // Keyword rows first, original order — structural no-shrink guarantee.
    expect(rows.slice(0, 2)).toEqual(keywordRows)
    expect(rows.map((r) => r.id)).toContain('s1')
    // k1 already present → not duplicated by the semantic lane
    expect(rows.filter((r) => r.id === 'k1')).toHaveLength(1)
    expect(meta.keyword_candidates).toBe(2)
    expect(meta.semantic_added).toBe(1)
  })

  it('no-ops cleanly when the embedder returns null (no key / outage)', async () => {
    setEnv('SEMANTIC_RECALL', '1')
    const keywordRows = [{ id: 'k1' }]
    const { rows, meta } = await augmentCandidatesWithSemanticRecall(db, {
      keywordRows,
      queryText: 'anything',
      whereSql: ISOLATION_WHERE,
      whereParams: [null],
      _embedText: async () => null,
    })
    expect(rows).toEqual(keywordRows)
    expect(meta.semantic_added).toBe(0)
  })
})
