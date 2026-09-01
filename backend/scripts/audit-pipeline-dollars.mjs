#!/usr/bin/env node
/**
 * Read-only audit: per-profile pipeline totals before/after dollar-contract fix.
 *
 * Prints:
 * - profile id, display_name
 * - old_total (SUM(pipelineValueSql))
 * - corrected_total (SUM(pipelineDollarSql with FO join + ineligible/REJECT zeroization)
 * - delta
 * - excluded rows by reason (pointer_kind, ineligible, reject)
 * - top 20 inflation contributors (title, funder, old_value, corrected_value, reason)
 * - wide-range rows (min/max ratio > WIDE_AWARD_RANGE_RATIO with requested==max)
 * - unvalued rows count
 *
 * No mutations; intended to run against prod via existing admin infra.
 */
import { getDb } from '../db/index.js'
import { PIPELINE_ACTIVE_STATUSES, pipelineValueSql, pipelineDollarSql, WIDE_AWARD_RANGE_RATIO } from '../config/pipelineValue.js'

async function main() {
  const db = getDb()
  const profiles = await db.prepare(`SELECT id, display_name FROM profiles WHERE status IS NULL OR status <> 'deleted'`).all()
  const lines = []
  const statusesSql = PIPELINE_ACTIVE_STATUSES.map((_) => '?').join(', ')
  for (const p of profiles) {
    const oldRow = await db.prepare(
      `SELECT COALESCE(SUM(${pipelineValueSql('g')}),0) AS t,
              COALESCE(SUM(CASE WHEN ${pipelineValueSql('g')}=0 THEN 1 ELSE 0 END),0) AS unvalued
         FROM grants g
        WHERE g.profile_id = ? AND g.status IN (${statusesSql})`
    ).get(p.id, ...PIPELINE_ACTIVE_STATUSES)
    const fixedRow = await db.prepare(
      `SELECT COALESCE(SUM(${pipelineDollarSql('g','fo')}),0) AS t
         FROM grants g
    LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id
        WHERE g.profile_id = ? AND g.status IN (${statusesSql})`
    ).get(p.id, ...PIPELINE_ACTIVE_STATUSES)
    const oldTotal = Number(oldRow?.t ?? 0)
    const corrected = Number(fixedRow?.t ?? 0)
    const delta = corrected - oldTotal

    // Exclusions by reason
    const excluded = await db.prepare(
      `SELECT g.id, g.title, g.funder,
              ${pipelineValueSql('g')} AS old_value,
              CASE
                WHEN LOWER(COALESCE(g.eligibility_status,''))='ineligible' THEN 'ineligible'
                WHEN LOWER(COALESCE(g.match_decision,''))='reject' THEN 'reject'
                WHEN LOWER(COALESCE(fo.opportunity_kind,'')) IN ('directory','past_award_intel','school_portal','referral','benefit') THEN 'pointer_kind'
                ELSE 'kept'
              END AS reason
         FROM grants g
    LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id
        WHERE g.profile_id=? AND g.status IN (${statusesSql})
          AND (
            LOWER(COALESCE(g.eligibility_status,''))='ineligible' OR LOWER(COALESCE(g.match_decision,''))='reject' OR
            LOWER(COALESCE(fo.opportunity_kind,'')) IN ('directory','past_award_intel','school_portal','referral','benefit')
          )`
    ).all(p.id, ...PIPELINE_ACTIVE_STATUSES)
    const byReason = excluded.reduce((m, r) => (m[r.reason] = (m[r.reason] || 0) + 1, m), {})

    // Top inflation contributors: rows where old_value > corrected_value
    const inflaters = await db.prepare(
      `SELECT g.id, g.title, g.funder,
              ${pipelineValueSql('g')} AS old_value,
              ${pipelineDollarSql('g','fo')} AS new_value,
              CASE
                WHEN LOWER(COALESCE(g.eligibility_status,''))='ineligible' THEN 'ineligible'
                WHEN LOWER(COALESCE(g.match_decision,''))='reject' THEN 'reject'
                WHEN LOWER(COALESCE(fo.opportunity_kind,'')) IN ('directory','past_award_intel','school_portal','referral','benefit') THEN 'pointer_kind'
                ELSE 'kept'
              END AS reason
         FROM grants g
    LEFT JOIN funding_opportunities fo ON fo.id=g.funding_opportunity_id
        WHERE g.profile_id=? AND g.status IN (${statusesSql})
          AND (${pipelineValueSql('g')} - ${pipelineDollarSql('g','fo')}) > 0
     ORDER BY ( (${pipelineValueSql('g')} - ${pipelineDollarSql('g','fo')}) ) DESC NULLS LAST
        LIMIT 20`
    ).all(p.id, ...PIPELINE_ACTIVE_STATUSES)

    // Wide-range rows
    const wide = await db.prepare(
      `SELECT g.id, g.title, g.funder, g.amount_min, g.amount_max, g.amount_requested
         FROM grants g
        WHERE g.profile_id=? AND COALESCE(g.amount_min,0) > 0 AND COALESCE(g.amount_max,0) > 0
          AND g.amount_max > g.amount_min * ${Number(WIDE_AWARD_RANGE_RATIO)}
          AND COALESCE(g.amount_requested,0) = COALESCE(g.amount_max,0)`
    ).all(p.id)

    lines.push({
      profile_id: p.id,
      display_name: p.display_name || null,
      old_total: Math.round(oldTotal),
      corrected_total: Math.round(corrected),
      delta: Math.round(delta),
      unvalued_rows: Number(oldRow?.unvalued ?? 0),
      excluded_by_reason: byReason,
      top_inflation_contributors: inflaters.map((r) => ({
        id: r.id, title: r.title, funder: r.funder,
        old_value: Math.round(Number(r.old_value || 0)),
        new_value: Math.round(Number(r.new_value || 0)),
        reason: r.reason,
      })),
      wide_range_rows: wide.map((r) => ({
        id: r.id, title: r.title, funder: r.funder,
        amount_min: Number(r.amount_min || 0),
        amount_max: Number(r.amount_max || 0),
        amount_requested: Number(r.amount_requested || 0),
      })),
    })
  }
  // Pretty-print JSON so it can be saved/attached
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), profiles: lines }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  main().catch((e) => { console.error(e?.message || e); process.exit(1) })
}

