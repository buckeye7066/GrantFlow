import { BOOT_ID } from '../config/bootId.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js'
import { isFundingResource } from './matching/fundingSourcePresentation.js'

export const PRODUCTION_AUDIT_SNAPSHOT_CONTRACT = 'production-audit-snapshot-v1'
export const MAX_AUDIT_PROFILES = 10
export const DEFAULT_MATCH_LIMIT_PER_PROFILE = 500
export const MAX_MATCH_LIMIT_PER_PROFILE = 1000

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const RESOURCE_KINDS = new Set(['DIRECTORY', 'REFERRAL', 'SCHOOL_PORTAL', 'PAST_AWARD_INTEL'])
const AUDIT_KV_KEYS = Object.freeze([
  'automation_posture',
  'amy_last_report',
  'amy_recent_runs',
  'amy_flywheel_cohort',
])

function auditError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

export function normalizeAuditProfileIds(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',')
  const profileIds = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))]
  if (profileIds.length === 0) {
    throw auditError('AUDIT_PROFILE_IDS_REQUIRED', 'At least one profile id is required.')
  }
  if (profileIds.length > MAX_AUDIT_PROFILES) {
    throw auditError(
      'AUDIT_PROFILE_LIMIT_EXCEEDED',
      `At most ${MAX_AUDIT_PROFILES} profile ids may be audited at once.`,
    )
  }
  const invalid = profileIds.filter((id) => !PROFILE_ID_RE.test(id))
  if (invalid.length > 0) {
    throw auditError('AUDIT_PROFILE_ID_INVALID', 'One or more profile ids are malformed.')
  }
  return profileIds
}

export function normalizeAuditMatchLimit(value) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MATCH_LIMIT_PER_PROFILE
  return Math.max(1, Math.min(MAX_MATCH_LIMIT_PER_PROFILE, parsed))
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function booleanValue(value, fallback = false) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return /^(1|true|yes|on)$/i.test(String(value))
}

function normalizedDecision(value) {
  return String(value || '').trim().toLowerCase() || null
}

function normalizedKind(row) {
  return String(row?.opportunity_kind || row?.result_kind || row?.type || '').trim().toUpperCase() || null
}

function canonicalDecision(row) {
  const evidence = parseJson(row?.match_explain_json, {})
  return normalizedDecision(evidence?.canonical_decision)
}

function isVisible(row) {
  return booleanValue(row?.is_active, true) && !booleanValue(row?.is_hidden, false)
}

function collapseWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function normalizeIdentityText(value) {
  return collapseWhitespace(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(scholarships|scholarship)\b/g, 'scholarship')
    .replace(/\b(grants|grant)\b/g, 'grant')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function duplicateIdentity(row) {
  const title = normalizeIdentityText(row?.title)
  const sponsor = normalizeIdentityText(row?.sponsor)
  if (!title) return null
  return `${title}|${sponsor}`
}

function summarizeFindingTypes(report) {
  const findings = Array.isArray(report?.amy?.handoff?.findings)
    ? report.amy.handoff.findings
    : []
  const byType = {}
  const bySeverity = {}
  for (const finding of findings) {
    const type = String(finding?.type || 'unknown')
    const severity = String(finding?.severity || 'unknown')
    byType[type] = (byType[type] || 0) + 1
    bySeverity[severity] = (bySeverity[severity] || 0) + 1
  }
  return {
    total: findings.length,
    by_type: byType,
    by_severity: bySeverity,
  }
}

function latestFlywheelDay(store) {
  const days = store?.days && typeof store.days === 'object' ? store.days : {}
  const key = Object.keys(days).sort().at(-1)
  if (!key) return null
  const day = days[key] || {}
  return {
    day: day.day || key,
    target: Number(day.target || 0),
    evaluated: Number(day.evaluated || 0),
    clean: Number(day.clean || 0),
    issues: Number(day.issues || 0),
    finding_types: day.finding_types || {},
    runs: Array.isArray(day.runs) ? day.runs.slice(-10) : [],
    complete: day.complete === true,
    all_clean: day.all_clean === true,
  }
}

export function summarizeAmyAuditState({ latestReport = null, history = null, flywheel = null } = {}) {
  const report = latestReport && typeof latestReport === 'object' ? latestReport : null
  const recent = Array.isArray(history) ? history : []
  return {
    latest: report
      ? {
          run_id: report.run_id || null,
          started_at: report.started_at || null,
          completed_at: report.completed_at || null,
          improve_enabled: report.improve_enabled === true,
          degraded: report.degraded === true,
          crawler_events: report.crawler_events || null,
          cohort: report.cohort || null,
          metrics_before: report.metrics?.before || null,
          metrics_after: report.metrics?.after || null,
          finding_counts: summarizeFindingTypes(report),
          flywheel_cohort: report.flywheel_cohort?.day || report.flywheel_cohort || null,
          flywheel_record_error: report.flywheel_record_error || null,
          fleet_gap_learning: report.fleet_gap_learning?.scoreboard
            ? {
                generated_at: report.fleet_gap_learning.scoreboard.generated_at || null,
                profiles_scanned: Number(report.fleet_gap_learning.scoreboard.profiles_scanned || 0),
                gap_classes: Number(report.fleet_gap_learning.scoreboard.gap_classes || 0),
                adapter_wishlist_count: Array.isArray(report.fleet_gap_learning.scoreboard.adapter_wishlist)
                  ? report.fleet_gap_learning.scoreboard.adapter_wishlist.length
                  : 0,
              }
            : null,
          archetypes_measured: report.archetype_metrics && typeof report.archetype_metrics === 'object'
            ? Object.keys(report.archetype_metrics).length
            : 0,
          archetypes_learned: report.archetype_learning?.update && typeof report.archetype_learning.update === 'object'
            ? Object.keys(report.archetype_learning.update).length
            : 0,
        }
      : null,
    flywheel: {
      latest_day: latestFlywheelDay(flywheel),
      goal_notified_at: flywheel?.goal_notified_at || null,
      updated_at: flywheel?.updated_at || null,
    },
    recent_runs: recent.slice(0, 10).map((run) => ({
      run_id: run?.run_id || null,
      completed_at: run?.completed_at || null,
      metrics_before: run?.metrics_before || null,
      metrics_after: run?.metrics_after || null,
      summary: run?.summary || null,
    })),
  }
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ')
}

async function readKvRows(db) {
  try {
    const rows = await db.prepare(
      `SELECT key, value, updated_at
         FROM system_kv
        WHERE key IN (${placeholders(AUDIT_KV_KEYS.length)})`,
    ).all(...AUDIT_KV_KEYS)
    return new Map((rows || []).map((row) => [String(row.key), row]))
  } catch {
    return new Map()
  }
}

async function runSnapshotQueries(db, { profileIds, matchLimitPerProfile }) {
  let transactionReadOnly = db?.dialect === 'postgres' ? null : 'select_only_code_path'
  if (db?.dialect === 'postgres') {
    await db.exec('SET TRANSACTION READ ONLY')
    const row = await db.prepare('SHOW transaction_read_only').get()
    transactionReadOnly = String(row?.transaction_read_only || '').toLowerCase()
    if (transactionReadOnly !== 'on') {
      throw auditError('AUDIT_TRANSACTION_NOT_READ_ONLY', 'The production audit transaction is not read-only.', 500)
    }
  }

  const idsSql = placeholders(profileIds.length)
  const profiles = await db.prepare(
    `SELECT id, display_name, primary_type
       FROM profiles
      WHERE id IN (${idsSql})
        AND deleted_at IS NULL
      ORDER BY display_name, id`,
  ).all(...profileIds)

  const matchRows = await db.prepare(
    `WITH ranked AS (
       SELECT pom.profile_id,
              pom.opportunity_id,
              pom.match_score,
              pom.match_decision,
              pom.matcher_version,
              pom.match_explain_json,
              pom.updated_at AS match_updated_at,
              fo.title,
              fo.sponsor,
              fo.source,
              fo.source_id,
              fo.opportunity_kind,
              fo.opportunity_type,
              fo.type,
              fo.result_kind,
              fo.is_active,
              fo.is_hidden,
              ROW_NUMBER() OVER (
                PARTITION BY pom.profile_id
                ORDER BY pom.match_score DESC, pom.updated_at DESC, pom.opportunity_id
              ) AS audit_rank
         FROM profile_opportunity_matches pom
         JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
        WHERE pom.profile_id IN (${idsSql})
          AND pom.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
     )
     SELECT *
       FROM ranked
      WHERE audit_rank <= ?
      ORDER BY profile_id, audit_rank`,
  ).all(...profileIds, matchLimitPerProfile)

  const normalizedMatches = (matchRows || []).map((row) => {
    const resource = isFundingResource(row) || RESOURCE_KINDS.has(normalizedKind(row))
    return {
      profile_id: String(row.profile_id),
      opportunity_id: String(row.opportunity_id),
      title: collapseWhitespace(row.title),
      sponsor: collapseWhitespace(row.sponsor) || null,
      opportunity_kind: normalizedKind(row),
      is_resource: resource,
      visible: isVisible(row),
      match_score: numberOrNull(row.match_score),
      match_decision: normalizedDecision(row.match_decision),
      canonical_decision: canonicalDecision(row),
      matcher_version: row.matcher_version || null,
      match_updated_at: row.match_updated_at || null,
    }
  })

  const duplicateBuckets = new Map()
  for (const row of normalizedMatches.filter((match) => match.visible)) {
    const identity = duplicateIdentity(row)
    if (!identity) continue
    const key = `${row.profile_id}|${identity}`
    const group = duplicateBuckets.get(key) || {
      profile_id: row.profile_id,
      identity,
      count: 0,
      opportunity_ids: [],
      titles: [],
    }
    group.count += 1
    group.opportunity_ids.push(row.opportunity_id)
    if (!group.titles.includes(row.title)) group.titles.push(row.title)
    duplicateBuckets.set(key, group)
  }
  const duplicateGroups = [...duplicateBuckets.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => b.count - a.count || a.profile_id.localeCompare(b.profile_id))

  const integrityByProfile = {}
  for (const profileId of profileIds) {
    const rows = normalizedMatches.filter((row) => row.profile_id === profileId)
    const visible = rows.filter((row) => row.visible)
    integrityByProfile[profileId] = {
      persisted_rows: rows.length,
      visible_rows: visible.length,
      visible_direct_rejects: visible.filter((row) => !row.is_resource && row.match_decision === 'reject').length,
      visible_resource_non_review: visible.filter((row) => row.is_resource && row.match_decision !== 'review').length,
      canonical_reject_relabelled: visible.filter(
        (row) => row.canonical_decision === 'reject' && row.match_decision !== 'reject',
      ).length,
      visible_missing_scores: visible.filter((row) => row.match_score === null).length,
      duplicate_groups: duplicateGroups.filter((group) => group.profile_id === profileId).length,
      duplicate_rows: duplicateGroups
        .filter((group) => group.profile_id === profileId)
        .reduce((sum, group) => sum + group.count, 0),
    }
  }

  let tasks = []
  try {
    tasks = await db.prepare(
      `SELECT id, profile_id, status, current_step, automation_type,
              allow_auto_submit, auto_submit_enabled, updated_at
         FROM application_tasks
        WHERE profile_id IN (${idsSql})
        ORDER BY profile_id, updated_at DESC, id
        LIMIT ?`,
    ).all(...profileIds, Math.max(200, profileIds.length * 200))
  } catch {
    tasks = []
  }
  const normalizedTasks = (tasks || []).map((task) => ({
    id: String(task.id),
    profile_id: String(task.profile_id),
    status: task.status || null,
    current_step: task.current_step || null,
    automation_type: task.automation_type || null,
    allow_auto_submit: booleanValue(task.allow_auto_submit, false),
    auto_submit_enabled: booleanValue(task.auto_submit_enabled, false),
    updated_at: task.updated_at || null,
  }))

  let repeatedMissingFields = []
  try {
    repeatedMissingFields = await db.prepare(
      `SELECT at.profile_id, ami.key, ami.kind,
              COUNT(DISTINCT ami.task_id) AS distinct_tasks
         FROM application_missing_info ami
         JOIN application_tasks at ON at.id = ami.task_id
        WHERE at.profile_id IN (${idsSql})
          AND ami.resolved IS NOT TRUE
          AND ami.kind = 'field'
          AND at.status NOT IN ('completed', 'cancelled')
        GROUP BY at.profile_id, ami.key, ami.kind
       HAVING COUNT(DISTINCT ami.task_id) >= 2
        ORDER BY distinct_tasks DESC, at.profile_id, ami.key
        LIMIT 200`,
    ).all(...profileIds)
  } catch {
    repeatedMissingFields = []
  }

  let portalSyncSummary = []
  try {
    portalSyncSummary = await db.prepare(
      `SELECT profile_id, portal_host, direction, status,
              COUNT(*) AS runs,
              MAX(started_at) AS last_run
         FROM portal_sync_runs
        WHERE profile_id IN (${idsSql})
        GROUP BY profile_id, portal_host, direction, status
        ORDER BY last_run DESC
        LIMIT 200`,
    ).all(...profileIds)
  } catch {
    portalSyncSummary = []
  }

  const kvRows = await readKvRows(db)
  const kv = (key) => parseJson(kvRows.get(key)?.value, null)
  const automationPosture = kv('automation_posture')
  const amy = summarizeAmyAuditState({
    latestReport: kv('amy_last_report'),
    history: kv('amy_recent_runs'),
    flywheel: kv('amy_flywheel_cohort'),
  })

  const taskIntegrityByProfile = Object.fromEntries(profileIds.map((profileId) => {
    const scoped = normalizedTasks.filter((task) => task.profile_id === profileId)
    return [profileId, {
      tasks: scoped.length,
      open_tasks: scoped.filter((task) => !['completed', 'cancelled', 'submitted'].includes(String(task.status))).length,
      autosubmit_flagged: scoped.filter((task) => task.allow_auto_submit || task.auto_submit_enabled).length,
      repeated_missing_fields: repeatedMissingFields.filter((row) => String(row.profile_id) === profileId).length,
    }]
  }))

  return {
    ok: true,
    contract: PRODUCTION_AUDIT_SNAPSHOT_CONTRACT,
    generated_at: new Date().toISOString(),
    deployment: {
      commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
      boot_id: BOOT_ID,
      node_env: process.env.NODE_ENV || null,
      runtime: process.env.RAILWAY_ENVIRONMENT ? 'railway' : (process.env.VERCEL ? 'vercel' : 'unknown'),
      database_dialect: db?.dialect || null,
    },
    safety: {
      admin_only: true,
      transaction_read_only: transactionReadOnly,
      query_model: 'hardcoded_selects_only',
      sensitive_tables_read: false,
      profile_limit: MAX_AUDIT_PROFILES,
      match_limit_per_profile: matchLimitPerProfile,
    },
    scope: {
      requested_profile_ids: profileIds,
      resolved_profiles: profiles || [],
      missing_profile_ids: profileIds.filter((id) => !(profiles || []).some((profile) => String(profile.id) === id)),
    },
    matches: {
      rows: normalizedMatches,
      integrity_by_profile: integrityByProfile,
      duplicate_groups: duplicateGroups.slice(0, 100),
      totals: {
        persisted_rows: normalizedMatches.length,
        visible_rows: normalizedMatches.filter((row) => row.visible).length,
        visible_direct_rejects: Object.values(integrityByProfile).reduce((sum, row) => sum + row.visible_direct_rejects, 0),
        visible_resource_non_review: Object.values(integrityByProfile).reduce((sum, row) => sum + row.visible_resource_non_review, 0),
        canonical_reject_relabelled: Object.values(integrityByProfile).reduce((sum, row) => sum + row.canonical_reject_relabelled, 0),
        duplicate_groups: duplicateGroups.length,
      },
    },
    hamilton: {
      tasks: normalizedTasks,
      integrity_by_profile: taskIntegrityByProfile,
      repeated_missing_fields: (repeatedMissingFields || []).map((row) => ({
        profile_id: String(row.profile_id),
        key: row.key || null,
        kind: row.kind || null,
        distinct_tasks: Number(row.distinct_tasks || 0),
      })),
      cross_scope_task_rows: normalizedTasks.filter((task) => !profileIds.includes(task.profile_id)).length,
    },
    portal_sync: (portalSyncSummary || []).map((row) => ({
      profile_id: String(row.profile_id),
      portal_host: row.portal_host || null,
      direction: row.direction || null,
      status: row.status || null,
      runs: Number(row.runs || 0),
      last_run: row.last_run || null,
    })),
    automation_posture: automationPosture
      ? {
          allow_auto_submit: automationPosture.allow_auto_submit === true,
          browser_automation: automationPosture.browser_automation === true,
          run_on_schedule: automationPosture.run_on_schedule === true,
          tailored_approval_gate: automationPosture.tailored_approval_gate !== false,
          boot_id: automationPosture.boot_id || null,
          captured_at: automationPosture.captured_at || null,
          matches_current_boot: automationPosture.boot_id === BOOT_ID,
        }
      : null,
    amy,
  }
}

export async function buildProductionAuditSnapshot(db, options = {}) {
  if (!db?.prepare) {
    throw auditError('AUDIT_DATABASE_UNAVAILABLE', 'Database unavailable.', 503)
  }
  const profileIds = normalizeAuditProfileIds(options.profileIds)
  const matchLimitPerProfile = normalizeAuditMatchLimit(options.matchLimitPerProfile)
  const run = (connection) => runSnapshotQueries(connection, { profileIds, matchLimitPerProfile })
  if (db.dialect === 'postgres' && typeof db.withTransaction === 'function') {
    return db.withTransaction(run)
  }
  return run(db)
}

export default {
  buildProductionAuditSnapshot,
  normalizeAuditProfileIds,
  normalizeAuditMatchLimit,
  summarizeAmyAuditState,
}
