// backend/services/crawlerOsPersistence.js
//
// Resource-preserving facade around the original persistence adapter. A fresh
// discovery run is authoritative for direct funding, but omission is not a
// negative eligibility verdict for a directory, referral, school portal, or
// past-award intelligence pointer. Snapshot those durable resource matches before
// the core reconcile, then restore only the rows the current run did not
// explicitly reject.

import {
  persistRun as persistRunCore,
  profileContextToThesisInput,
  sectionSignalText,
} from './crawlerOsPersistenceCore.js'
import { normalizePersistedMatchDecisionIntegrity } from './matching/matchDecisionIntegrity.js'

const RESOURCE_KINDS_SQL = "('DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL')"

function reconcileProfileIds(memStore, primaryProfileId) {
  if (primaryProfileId) return [String(primaryProfileId)]
  const rows = memStore?.all?.('profile_opportunity_matches') ?? []
  return [...new Set(rows.map((row) => String(row?.profile_id ?? '')).filter(Boolean))]
}

function isMissingSnapshotTable(error) {
  const message = String(error?.message ?? error ?? '')
  return Boolean(
    error?.code === '42P01' ||
    /no such table:\s*(profile_opportunity_matches|funding_opportunities)/i.test(message) ||
    /relation\s+["']?(profile_opportunity_matches|funding_opportunities)["']?\s+does not exist/i.test(message)
  )
}

async function snapshotResourceMatches(db, profileIds) {
  if (!db || profileIds.length === 0) return []

  // RESOURCE_KINDS_SQL is a frozen code constant, not user input. Profile ids
  // remain bound parameters. audit:allow dynamic-sql
  const fullSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
  `
  // RESOURCE_KINDS_SQL is a frozen code constant, not user input. Profile ids
  // remain bound parameters. audit:allow dynamic-sql
  const coreSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version,
           m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
  `

  const snapshots = []
  for (const profileId of profileIds) {
    try {
      snapshots.push(...(await db.prepare(fullSql).all(profileId)))
    } catch (error) {
      // A completely fresh database has nothing to preserve. The core adapter
      // creates the match table before writing the first run, so missing-table
      // is the one snapshot failure that is safely equivalent to an empty set.
      if (isMissingSnapshotTable(error)) continue

      // Older/minimal schemas can predate crawler-doctor provenance columns. The
      // resource contract still applies, so retry with the canonical match fields.
      try {
        snapshots.push(...(await db.prepare(coreSql).all(profileId)))
      } catch (fallbackError) {
        if (isMissingSnapshotTable(fallbackError)) continue
        const wrapped = new Error(
          `Resource reconciliation snapshot failed; refusing a destructive match refresh: ${fallbackError?.message || error?.message || fallbackError}`,
        )
        wrapped.code = 'RESOURCE_RECONCILIATION_SNAPSHOT_FAILED'
        throw wrapped
      }
    }
  }
  return snapshots
}

function currentExplicitRejects(memStore, idRemap) {
  const rows = memStore?.all?.('profile_opportunity_matches') ?? []
  const rejects = new Set()
  for (const row of rows) {
    if (String(row?.decision ?? '').toLowerCase() !== 'reject') continue
    const originalId = row?.opportunity_id
    const liveId = idRemap instanceof Map
      ? (idRemap.get(originalId) ?? originalId)
      : originalId
    rejects.add(`${String(row?.profile_id ?? '')}:${String(liveId ?? '')}`)
  }
  return rejects
}

async function restoreResourceMatches(db, snapshots, explicitRejects) {
  if (snapshots.length === 0) return 0

  const insertFull = db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      source_query, discovered_via, computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (profile_id, opportunity_id) DO NOTHING
  `)
  const insertCore = db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (profile_id, opportunity_id) DO NOTHING
  `)

  let restored = 0
  for (const row of snapshots) {
    const key = `${String(row.profile_id)}:${String(row.opportunity_id)}`
    if (explicitRejects.has(key)) continue

    const hasProvenanceColumns = Object.prototype.hasOwnProperty.call(row, 'source_query')
    const result = hasProvenanceColumns
      ? await insertFull.run(
          row.id,
          row.profile_id,
          row.opportunity_id,
          row.match_score,
          row.match_decision,
          row.match_explanation,
          row.match_reasons,
          row.match_explain_json,
          row.matcher_version,
          row.source_query ?? null,
          row.discovered_via ?? null,
          row.computed_at ?? null,
          row.updated_at ?? null,
          row.evaluated_at ?? null,
        )
      : await insertCore.run(
          row.id,
          row.profile_id,
          row.opportunity_id,
          row.match_score,
          row.match_decision,
          row.match_explanation,
          row.match_reasons,
          row.match_explain_json,
          row.matcher_version,
          row.computed_at ?? null,
          row.updated_at ?? null,
          row.evaluated_at ?? null,
        )

    restored += Number(result?.changes ?? result?.rowCount ?? 0)
  }
  return restored
}

export { profileContextToThesisInput, sectionSignalText }

export async function persistRun(db, memStore, run, opts = {}) {
  const profileIds = reconcileProfileIds(memStore, opts?.primaryProfileId ?? null)
  const durableResources = await snapshotResourceMatches(db, profileIds)
  const persisted = await persistRunCore(db, memStore, run, opts)
  const explicitRejects = currentExplicitRejects(memStore, persisted?.idRemap)
  const resourcesPreserved = await restoreResourceMatches(db, durableResources, explicitRejects)
  const matchDecisionIntegrity = await normalizePersistedMatchDecisionIntegrity(db, { profileIds })

  return {
    ...persisted,
    resourcesPreserved,
    matchDecisionIntegrity,
  }
}

export default {
  profileContextToThesisInput,
  sectionSignalText,
  persistRun,
}
