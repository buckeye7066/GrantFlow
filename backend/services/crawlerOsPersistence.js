// backend/services/crawlerOsPersistence.js
//
// Resource-preserving facade around the original persistence adapter. A fresh
// discovery run is authoritative for direct funding, so an omitted direct row
// must leave the rolling snapshot. Omission is not a negative eligibility
// verdict for a directory, referral, school portal, or past-award intelligence
// pointer, however: those are durable navigation resources rather than claims
// that a current crawl re-proved an award match. Snapshot only those deliberate
// pointer rows before the core reconcile, then restore rows the current run did
// not explicitly reject.

import {
  persistRun as persistRunCore,
  profileContextToThesisInput,
  sectionSignalText,
} from './crawlerOsPersistenceCore.js'
import { normalizePersistedMatchDecisionIntegrity } from './matching/matchDecisionIntegrity.js'
import { pointerKindSql } from '../config/opportunityKindClasses.js'

const RESOURCE_KIND_PREDICATE = pointerKindSql('o.opportunity_kind')

// CROSS-MATCH PRECISION (2026-08-03): a cross-profile row is a match only on
// ACCEPT (see persistRunCore's xmatch branch). The resource snapshot must hold
// the same bar, or every pre-existing xmatch REVIEW directory — another
// state's housing finance agency, a kidney-fund locator on a profile with no
// declared condition — is preserved across every reconcile FOREVER: omission
// is not a negative verdict for the profile's OWN resources, but a
// cross-profile REVIEW was never evidence to begin with.
const SNAPSHOT_DECISION_SQL =
  "(m.matcher_version <> 'crawler-os-xmatch' OR LOWER(COALESCE(m.match_decision, '')) = 'accept')"

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

function isMissingOpportunityKindColumn(error) {
  return /(?:no such column|column)[^\n]*opportunity_kind/i.test(
    String(error?.message ?? error ?? ''),
  )
}

async function readSnapshotRows(db, profileId, sqlCandidates, {
  errorCode,
  errorLabel,
  missingOpportunityKindIsEmpty = false,
}) {
  let lastError = null
  for (const sql of sqlCandidates) {
    try {
      return await db.prepare(sql).all(profileId)
    } catch (error) {
      if (isMissingSnapshotTable(error)) return []
      if (missingOpportunityKindIsEmpty && isMissingOpportunityKindColumn(error)) return []
      lastError = error
    }
  }

  const wrapped = new Error(
    `${errorLabel}; refusing a destructive match refresh: ${lastError?.message || lastError}`,
  )
  wrapped.code = errorCode
  throw wrapped
}

async function snapshotResourceMatches(db, profileIds) {
  if (!db || profileIds.length === 0) return []

  // RESOURCE_KIND_PREDICATE comes from the frozen pointer-kind registry, not
  // user input. Profile ids remain bound parameters. audit:allow dynamic-sql
  const fullSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_confidence, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND ${SNAPSHOT_DECISION_SQL}
       AND ${RESOURCE_KIND_PREDICATE}
  `
  // RESOURCE_KIND_PREDICATE comes from the frozen pointer-kind registry, not
  // user input. Profile ids remain bound parameters. audit:allow dynamic-sql
  const confidenceCoreSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_confidence, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version,
           m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND ${SNAPSHOT_DECISION_SQL}
       AND ${RESOURCE_KIND_PREDICATE}
  `
  const legacyFullSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND ${SNAPSHOT_DECISION_SQL}
       AND ${RESOURCE_KIND_PREDICATE}
  `
  // Final legacy projection for schemas that predate match_confidence itself.
  const legacyCoreSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version,
           m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND ${SNAPSHOT_DECISION_SQL}
       AND ${RESOURCE_KIND_PREDICATE}
  `

  const snapshots = []
  for (const profileId of profileIds) {
    snapshots.push(...(await readSnapshotRows(
      db,
      profileId,
      [fullSql, confidenceCoreSql, legacyFullSql, legacyCoreSql],
      {
        errorCode: 'RESOURCE_RECONCILIATION_SNAPSHOT_FAILED',
        errorLabel: 'Resource reconciliation snapshot failed',
        // A schema with no opportunity_kind cannot distinguish a pointer from
        // an award. Fail closed rather than resurrect an omitted direct ACCEPT.
        missingOpportunityKindIsEmpty: true,
      },
    )))
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
      id, profile_id, opportunity_id, match_score, match_confidence, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      source_query, discovered_via, computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (profile_id, opportunity_id) DO NOTHING
  `)
  const insertCore = db.prepare(`
    INSERT INTO profile_opportunity_matches (
      id, profile_id, opportunity_id, match_score, match_confidence, match_decision,
      match_explanation, match_reasons, match_explain_json, matcher_version,
      computed_at, updated_at, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          row.match_confidence ?? null,
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
          row.match_confidence ?? null,
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
  // Restores use ON CONFLICT DO NOTHING — this run's fresh insert always wins.
  const resourcesPreserved = await restoreResourceMatches(db, durableResources, explicitRejects)
  const matchDecisionIntegrity = await normalizePersistedMatchDecisionIntegrity(db, { profileIds })

  return {
    ...persisted,
    resourcesPreserved,
    // Backward-compatible result field. Direct ACCEPT durability is retired:
    // omitted award rows are no longer resurrected after the core reconcile.
    acceptsPreserved: 0,
    matchDecisionIntegrity,
  }
}

export default {
  profileContextToThesisInput,
  sectionSignalText,
  persistRun,
}
