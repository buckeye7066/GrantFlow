import { AWARD_RECORD_SOURCE_NAMES, opportunityKindOf } from '../../shared/opportunityFundability.js'

// Repair catalog classification only. Never delete reference evidence or alter
// user-progressed grants/applications. Read and admission guards protect rows
// immediately, including records beyond this bounded boot batch.
export async function reconcileHistoricalAwardKinds(db, limit = 5000) {
  const placeholders = AWARD_RECORD_SOURCE_NAMES.map(() => '?').join(', ')
  // audit:allow dynamic-sql — placeholders derive only from a frozen source registry; values are bound.
  const rows = await db.prepare(`SELECT id, source FROM funding_opportunities
    WHERE LOWER(TRIM(COALESCE(source, ''))) IN (${placeholders})
      AND UPPER(COALESCE(opportunity_kind, '')) <> 'PAST_AWARD_INTEL'
    ORDER BY id LIMIT ?`).all(...AWARD_RECORD_SOURCE_NAMES, limit)
  let repaired = 0
  for (const row of rows) {
    if (opportunityKindOf(row) !== 'PAST_AWARD_INTEL') continue
    const result = await db.prepare(`UPDATE funding_opportunities SET opportunity_kind = 'PAST_AWARD_INTEL'
      WHERE id = ? AND source = ? AND UPPER(COALESCE(opportunity_kind, '')) <> 'PAST_AWARD_INTEL'`).run(row.id, row.source)
    repaired += Number(result?.changes ?? result?.rowCount ?? 0)
  }
  return { scanned: rows.length, repaired }
}
