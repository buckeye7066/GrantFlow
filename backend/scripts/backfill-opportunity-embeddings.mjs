/**
 * backfill-opportunity-embeddings.mjs — embed existing funding_opportunities
 * rows into the opportunity_embeddings sidecar (SEMANTIC_RECALL feature).
 *
 * Usage:
 *   node backend/scripts/backfill-opportunity-embeddings.mjs [--limit=2000] [--batch=64] [--all]
 *
 * - Only embeds ACTIVE rows that have no embedding for the current model
 *   (idempotent; re-run any time). --all includes inactive rows.
 * - Requires OPENAI_API_KEY. Without it the script exits 1 with a clear
 *   message and changes nothing (the runtime feature also no-ops without it).
 * - Structured summary counters at the end (scanned / embedded / skipped /
 *   failed) so operators can paste the result into an audit note.
 */

import { getDb } from '../db/index.js'
import {
  EMBEDDING_MODEL,
  buildOpportunityEmbeddingText,
  embedTexts,
  upsertOpportunityEmbedding,
} from '../services/embeddings/embeddingService.js'
import { getNormalizedOpenAIKey } from '../utils/openaiClient.js'

function argValue(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!arg) return fallback
  const n = Number(arg.split('=')[1])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const LIMIT = argValue('limit', 2000)
const BATCH = Math.min(argValue('batch', 64), 256)
const INCLUDE_INACTIVE = process.argv.includes('--all')

async function main() {
  if (!getNormalizedOpenAIKey()) {
    console.error('[backfill-embeddings] OPENAI_API_KEY is not configured — nothing to do. Set the key and re-run.')
    process.exit(1)
  }

  const db = getDb()
  const activeVal = db.dialect === 'postgres' ? 'TRUE' : '1'
  const activeClause = INCLUDE_INACTIVE ? '' : `AND fo.is_active = ${activeVal}`

  const rows = await db
    .prepare(
      `SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.categories, fo.keywords,
              fo.eligibility_bullets, fo.state
       FROM funding_opportunities fo
       LEFT JOIN opportunity_embeddings oe
         ON oe.opportunity_id = fo.id AND oe.model = ?
       WHERE oe.opportunity_id IS NULL ${activeClause}
       ORDER BY fo.created_at DESC
       LIMIT ?`,
    )
    .all(EMBEDDING_MODEL, LIMIT)

  console.log(`[backfill-embeddings] model=${EMBEDDING_MODEL} candidates=${rows.length} batch=${BATCH}`)

  const counters = { scanned: rows.length, embedded: 0, skipped_no_text: 0, failed: 0 }

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const texts = batch.map((r) => buildOpportunityEmbeddingText(r))
    const withText = batch.filter((_, idx) => texts[idx])
    counters.skipped_no_text += batch.length - withText.length

    const vectors = await embedTexts(texts.filter(Boolean))
    if (!vectors) {
      // Provider outage / auth failure mid-run — stop rather than hammer.
      counters.failed += withText.length
      console.error(`[backfill-embeddings] embedding batch failed at offset ${i} — stopping (re-run to resume).`)
      break
    }

    for (let j = 0; j < withText.length; j++) {
      const vec = vectors[j]
      if (!vec) {
        counters.failed += 1
        continue
      }
      const ok = await upsertOpportunityEmbedding(db, withText[j].id, vec)
      if (ok) counters.embedded += 1
      else counters.failed += 1
    }
    console.log(`[backfill-embeddings] progress ${Math.min(i + BATCH, rows.length)}/${rows.length} embedded=${counters.embedded}`)
  }

  console.log(`[backfill-embeddings] DONE ${JSON.stringify(counters)}`)
  await db.close?.()
  process.exit(counters.failed > 0 && counters.embedded === 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[backfill-embeddings] fatal:', err?.message || err)
  process.exit(1)
})
