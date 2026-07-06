/**
 * embeddingService.js — semantic-recall embedding helper (SEMANTIC_RECALL).
 *
 * Role in the matching system (read this before touching):
 *   Embeddings are a RECALL BOOSTER ONLY. They may ADD candidate rows into the
 *   existing keyword/rule candidate scan before scoring; they must NEVER
 *   accept, reject, re-rank past, or override the deterministic decision
 *   authority (matchEngine.computeMatchDecision / scoreOpportunity). "Rules
 *   over score" holds: every semantically-recalled candidate goes through the
 *   exact same canonical scoring + threshold gates as a keyword candidate.
 *
 * Degradation contract (G8 / graceful fallback):
 *   - No OPENAI_API_KEY → embedText()/embedTexts() return null and callers
 *     skip semantic augmentation entirely. The old keyword path is unchanged.
 *   - Missing opportunity_embeddings table (migration not applied) → helpers
 *     catch and return empty results; never throw into a match route.
 *   - Feature is OFF unless SEMANTIC_RECALL=1 (or 'true') — default off in
 *     prod until proven.
 *
 * Storage:
 *   opportunity_embeddings(opportunity_id PK → funding_opportunities.id,
 *   model, dims, vector JSON-text, updated_at). On Postgres, when the
 *   pgvector extension is present the migration adds an `embedding vector(N)`
 *   column + index; nearestByVector() probes for that capability once per db
 *   instance and uses SQL KNN, falling back to the portable JSON/JS
 *   brute-force path (bounded scan) everywhere else.
 */

import { createOpenAIClient, summarizeOpenAIError } from '../../utils/openaiClient.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('embeddingService')

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small'
// text-embedding-3-small native dimensionality.
export const EMBEDDING_DIMS = 1536

/** Feature flag — default OFF. Reversible: unset the env var and every code
 * path returns to the pure keyword behavior (reads are additive-only). */
export function isSemanticRecallEnabled() {
  const v = String(process.env.SEMANTIC_RECALL || '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** Top-K semantic candidates added per match request (bounded token/CPU cost). */
export function semanticRecallTopK() {
  const n = Number(process.env.SEMANTIC_RECALL_TOP_K)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 25
}

/** Bounded brute-force scan size — same order as the matcher's own candidate
 * scan (a few hundred rows), so semantic recall never becomes a full-table
 * hot loop. */
export function semanticScanLimit() {
  const n = Number(process.env.SEMANTIC_RECALL_SCAN_LIMIT)
  return Number.isFinite(n) && n > 0 ? Math.min(5000, Math.floor(n)) : 1000
}

// ── vector math / serialization ──────────────────────────────────────

/**
 * Cosine similarity in [-1, 1]. Returns 0 for invalid/mismatched inputs so a
 * corrupt stored vector sorts to the bottom instead of throwing mid-request.
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i])
    const y = Number(b[i])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function serializeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return null
  return JSON.stringify(vec)
}

export function parseVector(stored) {
  if (Array.isArray(stored)) return stored.length > 0 ? stored : null
  if (typeof stored !== 'string' || !stored.trim()) return null
  try {
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}

// ── embedding text builders ──────────────────────────────────────────

function asList(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : v ? [v] : []
    } catch {
      return v ? [v] : []
    }
  }
  return []
}

/**
 * Canonical text an opportunity is embedded under. Bounded so a scraped
 * description can't blow up token cost.
 */
export function buildOpportunityEmbeddingText(opp) {
  if (!opp || typeof opp !== 'object') return ''
  const parts = [
    opp.title,
    opp.sponsor || opp.funder,
    String(opp.description || '').slice(0, 1500),
    asList(opp.categories).join(' '),
    asList(opp.keywords).join(' '),
    asList(opp.eligibility_bullets).join(' ').slice(0, 500),
    opp.state && opp.state !== 'nationwide' ? `state:${opp.state}` : null,
  ]
  return parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '')
    .map((p) => String(p).trim())
    .join('\n')
    .slice(0, 6000)
}

/**
 * Canonical text a profile is embedded under (the "profile thesis"). Accepts
 * either a raw profile row (organizations/profiles) or a crawler-OS thesis
 * from profileIntelligence.buildThesis(). Only reads — never mutates.
 */
export function buildProfileEmbeddingText(profileLike, thesis = null) {
  const p = profileLike || {}
  const parts = [
    p.name || p.display_name,
    p.mission,
    String(p.description || '').slice(0, 1200),
    p.focus_areas,
    p.organization_type || p.applicant_type || p.profile_category,
    p.state ? `state:${p.state}` : null,
    p.city,
  ]
  if (thesis && typeof thesis === 'object') {
    parts.push(
      (thesis.applicant_types || []).join(' '),
      (thesis.needs || []).join(' '),
      (thesis.keywords || []).join(' '),
      (thesis.interest_terms || []).join(' '),
      thesis.field_of_study,
      thesis.school,
      thesis.location?.state ? `state:${thesis.location.state}` : null,
    )
  }
  return parts
    .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
    .map((x) => String(x).trim())
    .join('\n')
    .slice(0, 6000)
}

// ── OpenAI embedding calls (graceful no-op without a key) ────────────

function getEmbeddingClient() {
  try {
    return createOpenAIClient({ allowMissing: true }).openai
  } catch {
    return null
  }
}

/**
 * Embed one text → number[] | null. NEVER throws: no key, empty text, or a
 * provider error all resolve to null so callers skip augmentation cleanly.
 */
export async function embedText(text, { openai = null } = {}) {
  const results = await embedTexts([text], { openai })
  return results ? results[0] : null
}

/**
 * Embed a batch of texts → Array<number[]|null> | null (null when the
 * provider is unavailable entirely). Used by the backfill script.
 */
export async function embedTexts(texts, { openai = null } = {}) {
  const inputs = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '').trim())
  if (inputs.length === 0 || inputs.every((t) => !t)) return null
  const client = openai || getEmbeddingClient()
  if (!client) return null
  try {
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: inputs.map((t) => (t ? t : ' ')),
    })
    const rows = Array.isArray(response?.data) ? response.data : []
    if (rows.length !== inputs.length) {
      log.warn(`embedTexts: expected ${inputs.length} embeddings, got ${rows.length} — skipping batch`)
      return null
    }
    return rows.map((r, i) => {
      if (!inputs[i]) return null
      return Array.isArray(r?.embedding) && r.embedding.length > 0 ? r.embedding : null
    })
  } catch (error) {
    const summary = summarizeOpenAIError(error)
    log.warn(`embedTexts failed (semantic recall skipped): ${summary?.message || error?.message || error}`)
    return null
  }
}

// ── persistence ──────────────────────────────────────────────────────

/**
 * Upsert one opportunity embedding. Best-effort: a missing table (migration
 * not applied yet) or any DB error logs and returns false — an embedding
 * write failure must never break an opportunity insert.
 */
export async function upsertOpportunityEmbedding(db, opportunityId, vector, { model = EMBEDDING_MODEL } = {}) {
  const serialized = serializeVector(vector)
  if (!db || !opportunityId || !serialized) return false
  try {
    if (db.dialect === 'postgres') {
      await db
        .prepare(
          `INSERT INTO opportunity_embeddings (opportunity_id, model, dims, vector, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (opportunity_id) DO UPDATE SET
             model = EXCLUDED.model, dims = EXCLUDED.dims, vector = EXCLUDED.vector, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(opportunityId, model, vector.length, serialized)
      // Optional pgvector column — populate when the capability exists.
      if (await hasPgVectorColumn(db)) {
        try {
          await db
            .prepare(`UPDATE opportunity_embeddings SET embedding = ?::vector WHERE opportunity_id = ?`)
            .run(serialized, opportunityId)
        } catch (err) {
          log.warn(`pgvector column update failed (JSON path still valid): ${err?.message || err}`)
        }
      }
    } else {
      await db
        .prepare(
          `INSERT INTO opportunity_embeddings (opportunity_id, model, dims, vector, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (opportunity_id) DO UPDATE SET
             model = excluded.model, dims = excluded.dims, vector = excluded.vector, updated_at = CURRENT_TIMESTAMP`,
        )
        .run(opportunityId, model, vector.length, serialized)
    }
    return true
  } catch (error) {
    log.warn(`upsertOpportunityEmbedding failed for ${opportunityId}: ${error?.message || error}`)
    return false
  }
}

/**
 * Lazily embed an opportunity right after upsert. Fully gated: does nothing
 * unless SEMANTIC_RECALL=1 AND an embedding provider is configured. NEVER
 * throws and never blocks the insert result semantics (caller may fire and
 * forget or await — both safe).
 */
export async function maybeEmbedOpportunity(db, opportunityId, opportunity) {
  if (!isSemanticRecallEnabled()) return false
  const text = buildOpportunityEmbeddingText(opportunity)
  if (!text) return false
  const vector = await embedText(text)
  if (!vector) return false
  return upsertOpportunityEmbedding(db, opportunityId, vector)
}

// ── retrieval ────────────────────────────────────────────────────────

// pgvector capability probe, cached per db instance.
const _pgVectorCache = new WeakMap()

async function hasPgVectorColumn(db) {
  if (!db || db.dialect !== 'postgres') return false
  if (_pgVectorCache.has(db)) return _pgVectorCache.get(db)
  let has = false
  try {
    const ext = await db
      .prepare(`SELECT extname FROM pg_extension WHERE extname = 'vector' LIMIT 1`)
      .get()
    if (ext?.extname === 'vector') {
      const col = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'opportunity_embeddings' AND column_name = 'embedding'`,
        )
        .get()
      has = Boolean(col?.column_name)
    }
  } catch (err) {
    log.warn(`pgvector capability probe failed (using JSON path): ${err?.message || err}`)
    has = false
  }
  _pgVectorCache.set(db, has)
  return has
}

/**
 * Nearest embedded opportunities to a query vector.
 *
 * TENANCY-CRITICAL CONTRACT: `whereSql` + `whereParams` are the CALLER'S OWN
 * candidate-scan WHERE fragment (is_active + trusted origin/source + the
 * `profile_id IS NULL OR profile_id = ?` isolation clause, and any state/
 * deadline filters). Passing the exact same fragment the keyword scan used is
 * what guarantees semantic recall can never cross profile isolation or widen
 * the trust surface. `whereSql` must reference funding_opportunities as `fo`.
 *
 * Returns [{ ...opportunityRow, semantic_similarity }] sorted by similarity
 * desc, capped to `topK`, with `excludeIds` removed. Empty array on ANY
 * failure (missing table, bad vectors) — never throws.
 */
export async function nearestOpportunitiesByVector(db, {
  queryVector,
  whereSql = 'fo.profile_id IS NULL',
  whereParams = [],
  topK = semanticRecallTopK(),
  excludeIds = new Set(),
  scanLimit = semanticScanLimit(),
} = {}) {
  if (!db || !Array.isArray(queryVector) || queryVector.length === 0) return []
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])

  // Preferred: pgvector SQL KNN (Postgres with the extension + column).
  if (await hasPgVectorColumn(db)) {
    try {
      const rows = await db
        .prepare(
          `SELECT fo.*, 1 - (oe.embedding <=> ?::vector) AS semantic_similarity
           FROM opportunity_embeddings oe
           JOIN funding_opportunities fo ON fo.id = oe.opportunity_id
           WHERE oe.embedding IS NOT NULL AND (${whereSql})
           ORDER BY oe.embedding <=> ?::vector
           LIMIT ?`,
        )
        .all(serializeVector(queryVector), ...whereParams, serializeVector(queryVector), topK + exclude.size)
      return rows
        .filter((r) => !exclude.has(String(r.id)))
        .slice(0, topK)
    } catch (error) {
      log.warn(`pgvector KNN failed — falling back to JSON scan: ${error?.message || error}`)
      // fall through to the portable path
    }
  }

  // Portable path: bounded brute-force cosine over the most recently updated
  // embeddings (JSON vectors), any dialect.
  try {
    const rows = await db
      .prepare(
        `SELECT fo.*, oe.vector AS _embedding_vector
         FROM opportunity_embeddings oe
         JOIN funding_opportunities fo ON fo.id = oe.opportunity_id
         WHERE (${whereSql})
         ORDER BY oe.updated_at DESC
         LIMIT ?`,
      )
      .all(...whereParams, scanLimit)
    const scored = []
    for (const row of rows || []) {
      if (exclude.has(String(row.id))) continue
      const vec = parseVector(row._embedding_vector)
      if (!vec) continue
      const similarity = cosineSimilarity(queryVector, vec)
      if (similarity <= 0) continue
      const clean = { ...row, semantic_similarity: similarity }
      delete clean._embedding_vector
      scored.push(clean)
    }
    scored.sort((a, b) => b.semantic_similarity - a.semantic_similarity)
    return scored.slice(0, topK)
  } catch (error) {
    // Missing table / any DB error — semantic recall silently contributes 0
    // extra candidates; the keyword path is unaffected (G2-safe).
    log.warn(`semantic nearest scan skipped: ${error?.message || error}`)
    return []
  }
}

/**
 * ADDITIVE-ONLY augmentation helper used by the match routes.
 *
 * Takes the keyword scan's rows and returns { rows, meta } where `rows` is a
 * SUPERSET of the input (keyword rows always come first, in their original
 * order). Any failure returns the input rows untouched. This shape makes the
 * "semantic recall never removes a keyword result" invariant structural
 * rather than behavioral.
 */
export async function augmentCandidatesWithSemanticRecall(db, {
  keywordRows,
  queryText,
  whereSql,
  whereParams,
  topK = semanticRecallTopK(),
  // Test seam: inject a deterministic embedder so unit tests stay hermetic.
  _embedText = embedText,
} = {}) {
  const base = Array.isArray(keywordRows) ? keywordRows : []
  const meta = {
    enabled: isSemanticRecallEnabled(),
    keyword_candidates: base.length,
    semantic_added: 0,
    model: EMBEDDING_MODEL,
  }
  if (!meta.enabled) return { rows: base, meta }
  const text = String(queryText || '').trim()
  if (!text) return { rows: base, meta }

  const queryVector = await _embedText(text)
  if (!queryVector) return { rows: base, meta } // no key / provider down → clean no-op

  const excludeIds = new Set(base.map((r) => String(r?.id)).filter(Boolean))
  const added = await nearestOpportunitiesByVector(db, {
    queryVector,
    whereSql,
    whereParams,
    topK,
    excludeIds,
  })
  meta.semantic_added = added.length
  return { rows: [...base, ...added], meta }
}

export default {
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  isSemanticRecallEnabled,
  semanticRecallTopK,
  cosineSimilarity,
  serializeVector,
  parseVector,
  buildOpportunityEmbeddingText,
  buildProfileEmbeddingText,
  embedText,
  embedTexts,
  upsertOpportunityEmbedding,
  maybeEmbedOpportunity,
  nearestOpportunitiesByVector,
  augmentCandidatesWithSemanticRecall,
}
