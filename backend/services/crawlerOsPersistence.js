// backend/services/crawlerOsPersistence.js
//
// Resource-preserving facade around the original persistence adapter. A fresh
// discovery run is authoritative for direct funding, but omission is not a
// negative eligibility verdict for a directory, referral, school portal, or
// past-award intelligence pointer. Snapshot those durable resource matches before
// the core reconcile, then restore only the rows the current run did not
// explicitly reject.
//
// ACCEPT DURABILITY (2026-08-04, Instrumentl-class recall): engine ACCEPTs on
// awardable (non-pointer) rows are also snapshotted and restored. The rolling
// snapshot DELETE in persistRunCore wipes crawler-os rows every run; without
// this, a real ACCEPT (HOPE 100, AFTE 83) vanishes the moment a later crawl
// does not re-find it — the measured Google-bar failure mode. An explicit
// REJECT in the current run still clears the prior ACCEPT (restore skips it).

import {
  persistRun as persistRunCore,
  profileContextToThesisInput,
  sectionSignalText,
} from './crawlerOsPersistenceCore.js'
import { normalizePersistedMatchDecisionIntegrity } from './matching/matchDecisionIntegrity.js'
import { POINTER_KINDS } from '../config/opportunityKindClasses.js'

const RESOURCE_KINDS_SQL = "('DIRECTORY', 'PAST_AWARD_INTEL', 'SCHOOL_PORTAL', 'REFERRAL')"

// Pointer kinds that must NOT ride the awardable-ACCEPT durability path —
// directories already use snapshotResourceMatches. Quoted UPPER for SQL IN lists
// (prod stores mixed case; predicates use UPPER(...)).
const POINTER_KINDS_SQL = `(${POINTER_KINDS.map((k) => `'${String(k).toUpperCase()}'`).join(', ')})`

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

  // RESOURCE_KINDS_SQL is a frozen code constant, not user input. Profile ids
  // remain bound parameters. audit:allow dynamic-sql
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
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
  `
  // RESOURCE_KINDS_SQL is a frozen code constant, not user input. Profile ids
  // remain bound parameters. audit:allow dynamic-sql
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
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
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
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
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
       AND UPPER(COALESCE(o.opportunity_kind, '')) IN ${RESOURCE_KINDS_SQL}
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
        // A schema with no opportunity_kind cannot identify resource rows.
        // Durable ACCEPTs still use their kind-free fallbacks below.
        missingOpportunityKindIsEmpty: true,
      },
    )))
  }
  return snapshots
}

/**
 * Snapshot engine ACCEPTs on awardable (non-pointer) opportunities so a later
 * crawl that does not re-find them cannot erase a live endorsement. Pointers
 * stay on the resource path. Explicit REJECT in the new run still clears.
 */
async function snapshotDurableAccepts(db, profileIds) {
  if (!db || profileIds.length === 0) return []

  // POINTER_KINDS_SQL is a frozen registry constant. audit:allow dynamic-sql
  const sql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_confidence, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
      JOIN funding_opportunities o ON o.id = m.opportunity_id
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND LOWER(COALESCE(m.match_decision, '')) = 'accept'
       AND UPPER(COALESCE(o.opportunity_kind, '')) NOT IN ${POINTER_KINDS_SQL}
  `
  const kindFreeFullSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_confidence, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND LOWER(COALESCE(m.match_decision, '')) = 'accept'
  `
  const kindFreeConfidenceCoreSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_confidence, m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version,
           m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND LOWER(COALESCE(m.match_decision, '')) = 'accept'
  `
  const kindFreeLegacyFullSql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version, m.source_query,
           m.discovered_via, m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND LOWER(COALESCE(m.match_decision, '')) = 'accept'
  `
  const kindFreeLegacySql = `
    SELECT m.id, m.profile_id, m.opportunity_id, m.match_score,
           m.match_decision, m.match_explanation, m.match_reasons,
           m.match_explain_json, m.matcher_version,
           m.computed_at, m.updated_at, m.evaluated_at
      FROM profile_opportunity_matches m
     WHERE m.profile_id = ?
       AND m.matcher_version IN ('crawler-os', 'crawler-os-xmatch')
       AND LOWER(COALESCE(m.match_decision, '')) = 'accept'
  `

  const snapshots = []
  for (const profileId of profileIds) {
    snapshots.push(...(await readSnapshotRows(
      db,
      profileId,
      [
        sql,
        kindFreeFullSql,
        kindFreeConfidenceCoreSql,
        kindFreeLegacyFullSql,
        kindFreeLegacySql,
      ],
      {
        errorCode: 'ACCEPT_DURABILITY_SNAPSHOT_FAILED',
        errorLabel: 'Accept durability snapshot failed',
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
  const durableAccepts = await snapshotDurableAccepts(db, profileIds)
  const persisted = await persistRunCore(db, memStore, run, opts)
  const explicitRejects = currentExplicitRejects(memStore, persisted?.idRemap)
  // Restores use ON CONFLICT DO NOTHING — this run's fresh insert always wins.
  const resourcesPreserved = await restoreResourceMatches(db, durableResources, explicitRejects)
  const acceptsPreserved = await restoreResourceMatches(db, durableAccepts, explicitRejects)
  const matchDecisionIntegrity = await normalizePersistedMatchDecisionIntegrity(db, { profileIds })

  return {
    ...persisted,
    resourcesPreserved,
    acceptsPreserved,
    matchDecisionIntegrity,
  }
}

export default {
  profileContextToThesisInput,
  sectionSignalText,
  persistRun,
}
