// EVA run store — persistence, finding deduplication, and lifecycle analysis.
//
// Given a VALIDATED, REDACTED result payload (evaIngest does validation +
// signature + redaction upstream), persistRun writes the run/app/journey rows
// and folds each failure into the deduplicated eva_findings table, computing
// the lifecycle transition (new/recurring/worsened/intermittent/resolved) from
// the finding's prior state. A passing journey resolves any open finding with
// the same fingerprint.
//
// All SQL goes through db.prepare(...).run/get/all with `?` placeholders and is
// awaited (works on both the SQLite and Postgres shims). No BOOLEAN columns are
// filtered; lifecycle is TEXT.
import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'
import { computeFingerprint, normalizeFailureClass, normalizeErrorSignature, SEVERITY_RANK, redactText } from './evaTypes.js'

const log = createLogger('service:eva:store')

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`
}
function nowIso() {
  return new Date().toISOString()
}
function j(value) {
  return value == null ? null : JSON.stringify(value)
}
function isWorse(next, prior) {
  const a = SEVERITY_RANK[next]
  const b = SEVERITY_RANK[prior]
  if (a == null || b == null) return false
  return a < b // lower rank = more severe
}

/**
 * Persist a full validated+redacted result payload. Idempotent on
 * idempotency_key: a duplicate upload returns the already-stored run without
 * re-applying lifecycle transitions (so a runner retry can never inflate
 * recurrence counts).
 *
 * @returns {Promise<{ run_id, duplicate, findings: Array, resolved: Array }>}
 */
export async function persistRun(db, payload, { idempotencyKey = null, nonce = null, payloadBytes = 0, now = null } = {}) {
  const at = now || nowIso()

  if (idempotencyKey) {
    const existing = await db.prepare('SELECT id FROM eva_runs WHERE idempotency_key = ? LIMIT 1').get(idempotencyKey)
    if (existing?.id) {
      log.info('eva persistRun: duplicate idempotency key, skipping', { idempotencyKey })
      return { run_id: existing.id, duplicate: true, findings: [], resolved: [] }
    }
  }

  const runRowId = newId('evarun')
  const apps = Array.isArray(payload.apps) ? payload.apps : []
  const appsTested = apps.filter((a) => a.app_status === 'tested').length
  let journeysTotal = 0
  let journeysPassed = 0
  let journeysFailed = 0
  for (const app of apps) {
    for (const jn of app.journeys || []) {
      journeysTotal++
      if (jn.status === 'passed') journeysPassed++
      else if (jn.status === 'failed') journeysFailed++
    }
  }

  const findingsTouched = []
  const resolvedTouched = []

  // All writes run in ONE transaction so a mid-batch failure leaves NO partial
  // run (which the idempotency guard would later mistake for a complete one) and
  // no half-applied lifecycle transitions. Falls back to direct writes when the
  // db shim has no withTransaction (the run is then best-effort, same as before).
  const doWrites = async (conn) => {
  await conn.prepare(`INSERT INTO eva_runs
    (id, run_id, runner_id, runner_version, environment, is_catchup, started_at, completed_at, received_at,
     idempotency_key, nonce, apps_expected, apps_tested, journeys_total, journeys_passed, journeys_failed, payload_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runRowId,
    String(payload.run_id),
    String(payload.runner_id),
    payload.runner_version || null,
    String(payload.environment),
    payload.catchup ? 1 : 0,
    String(payload.started_at),
    String(payload.completed_at),
    at,
    idempotencyKey,
    nonce,
    apps.length,
    appsTested,
    journeysTotal,
    journeysPassed,
    journeysFailed,
    payloadBytes,
  )

  for (const app of apps) {
    const appRunId = newId('evaapp')
    const fc = app.feature_coverage || {}
    await conn.prepare(`INSERT INTO eva_app_runs
      (id, run_id, app_id, display_name, repo, commit_sha, app_status, blocker_reason, duration_ms,
       features_total, features_covered, unautomated_features_json, journeys_total, journeys_passed, journeys_failed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      appRunId,
      runRowId,
      String(app.app_id),
      app.display_name || null,
      app.repo || null,
      app.commit_sha || null,
      String(app.app_status),
      app.blocker_reason ? redactText(app.blocker_reason) : null,
      Number(app.duration_ms) || 0,
      Number(fc.features_total) || 0,
      Number(fc.features_covered) || 0,
      j(fc.unautomated_features || null),
      (app.journeys || []).length,
      (app.journeys || []).filter((x) => x.status === 'passed').length,
      (app.journeys || []).filter((x) => x.status === 'failed').length,
      at,
    )

    for (const jn of app.journeys || []) {
      const jrId = newId('evajr')
      const fingerprint =
        jn.status === 'failed'
          ? computeFingerprint({
              app_id: app.app_id,
              journey_id: jn.journey_id,
              failure_class: jn.failure_class,
              route_or_control: jn.route_or_control,
              error_signature: jn.error_signature,
            })
          : null

      await conn.prepare(`INSERT INTO eva_journey_results
        (id, app_run_id, run_id, app_id, journey_id, name, status, severity, retry_classification, duration_ms,
         route_or_control, failure_class, error_signature, expected_behavior, observed_behavior, repro_steps_json,
         user_impact, likely_root_cause, recommended_fix, candidate_files_json, diagnostic_confidence, missing_evidence,
         evidence_json, fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        jrId,
        appRunId,
        runRowId,
        String(app.app_id),
        String(jn.journey_id),
        String(jn.name),
        String(jn.status),
        jn.severity || null,
        jn.retry_classification || null,
        Number(jn.duration_ms) || 0,
        jn.route_or_control || null,
        jn.failure_class ? normalizeFailureClass(jn.failure_class) : null,
        jn.error_signature ? normalizeErrorSignature(jn.error_signature) : null,
        jn.expected_behavior || null,
        jn.observed_behavior || null,
        j(jn.repro_steps || null),
        jn.user_impact || null,
        jn.likely_root_cause || null,
        jn.recommended_fix || null,
        j(jn.candidate_files || null),
        typeof jn.diagnostic_confidence === 'number' ? jn.diagnostic_confidence : null,
        jn.missing_evidence || null,
        j(jn.evidence || null),
        fingerprint,
        at,
      )

      // Evidence metadata rows (by reference only).
      for (const ev of jn.evidence || []) {
        await conn.prepare(`INSERT INTO eva_evidence (id, journey_result_id, kind, ref, sha256, bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          newId('evaev'), jrId, String(ev.kind), redactText(String(ev.ref)), ev.sha256 || null, Number(ev.bytes) || null, at,
        )
      }

      if (jn.status === 'failed' && fingerprint) {
        const touched = await foldFinding(conn, { fingerprint, app, jn, runRowId, journeyResultId: jrId, at })
        findingsTouched.push(touched)
      } else if (jn.status === 'passed') {
        const resolved = await resolveOpenFindingsForJourney(conn, { app, jn, runRowId, at })
        resolvedTouched.push(...resolved)
      }
    }
  }
  } // end doWrites

  if (typeof db.withTransaction === 'function') {
    await db.withTransaction(doWrites)
  } else {
    await doWrites(db)
  }

  return { run_id: runRowId, duplicate: false, findings: findingsTouched, resolved: resolvedTouched }
}

// Fold a single failure into the deduplicated finding, computing the lifecycle
// transition from its prior state.
async function foldFinding(db, { fingerprint, app, jn, runRowId, journeyResultId, at }) {
  const prior = await db.prepare('SELECT * FROM eva_findings WHERE fingerprint = ? LIMIT 1').get(fingerprint)
  const intermittent = jn.retry_classification === 'intermittent'

  if (!prior) {
    await db.prepare(`INSERT INTO eva_findings
      (fingerprint, app_id, journey_id, display_name, journey_name, failure_class, route_or_control, severity,
       lifecycle_state, first_seen_at, last_seen_at, first_seen_run_id, last_seen_run_id, recurrence_count,
       intermittent_count, latest_journey_result_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
      fingerprint,
      String(app.app_id),
      String(jn.journey_id),
      app.display_name || null,
      jn.name || null,
      jn.failure_class ? normalizeFailureClass(jn.failure_class) : null,
      jn.route_or_control || null,
      jn.severity || null,
      intermittent ? 'intermittent' : 'new',
      at,
      at,
      runRowId,
      runRowId,
      intermittent ? 1 : 0,
      journeyResultId,
      at,
    )
    return { fingerprint, state: intermittent ? 'intermittent' : 'new', app_id: app.app_id }
  }

  // A finding that had been resolved and reappears is a regression -> recurring
  // (or worsened if severity climbed). Otherwise it is recurring/worsened/
  // intermittent based on this observation vs. the stored severity.
  let state = 'recurring'
  if (intermittent) state = 'intermittent'
  else if (isWorse(jn.severity, prior.severity)) state = 'worsened'

  await db.prepare(`UPDATE eva_findings SET
      last_seen_at = ?, last_seen_run_id = ?, recurrence_count = recurrence_count + 1,
      intermittent_count = intermittent_count + ?, severity = ?, prior_severity = ?,
      lifecycle_state = ?, journey_name = ?, failure_class = ?, route_or_control = ?,
      display_name = ?, latest_journey_result_id = ?, resolved_at = NULL, resolved_run_id = NULL, updated_at = ?
      WHERE fingerprint = ?`).run(
    at,
    runRowId,
    intermittent ? 1 : 0,
    jn.severity || prior.severity,
    prior.severity || null,
    state,
    jn.name || prior.journey_name,
    jn.failure_class ? normalizeFailureClass(jn.failure_class) : prior.failure_class,
    jn.route_or_control || prior.route_or_control,
    app.display_name || prior.display_name,
    journeyResultId,
    at,
    fingerprint,
  )
  return { fingerprint, state, app_id: app.app_id }
}

// A passing journey resolves any open finding on the same (app_id, journey_id).
// This is intentionally journey-scoped, not fingerprint-scoped: the passing run
// carries no failure fingerprint, and a green journey means the user path works
// now regardless of which specific failure last broke it.
async function resolveOpenFindingsForJourney(db, { app, jn, runRowId, at }) {
  const open = await db.prepare(
    `SELECT fingerprint, lifecycle_state FROM eva_findings
     WHERE app_id = ? AND journey_id = ? AND lifecycle_state NOT IN ('resolved')`,
  ).all(String(app.app_id), String(jn.journey_id))

  const resolved = []
  for (const row of open || []) {
    await db.prepare(`UPDATE eva_findings SET
        lifecycle_state = 'resolved', resolved_at = ?, resolved_run_id = ?,
        last_passing_run_id = ?, last_passing_at = ?, updated_at = ?
        WHERE fingerprint = ?`).run(at, runRowId, runRowId, at, at, row.fingerprint)
    resolved.push({ fingerprint: row.fingerprint, app_id: app.app_id, journey_id: jn.journey_id })
  }
  return resolved
}

/** Upsert a runner heartbeat (UPDATE-then-INSERT, shim-safe). */
export async function recordHeartbeat(db, { runnerId, version = null, status = 'ok', note = null, hostnameHash = null, now = null }) {
  const at = now || nowIso()
  const res = await db.prepare(
    `UPDATE eva_runner_heartbeats SET last_seen_at = ?, runner_version = ?, status = ?, note = ?, hostname_hash = ?, updated_at = ?
     WHERE runner_id = ?`,
  ).run(at, version, status, note ? redactText(note) : null, hostnameHash, at, String(runnerId))
  if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
    await db.prepare(
      `INSERT INTO eva_runner_heartbeats (runner_id, last_seen_at, runner_version, status, note, hostname_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(String(runnerId), at, version, status, note ? redactText(note) : null, hostnameHash, at)
  }
  return { runnerId, last_seen_at: at }
}

/** Latest overall run row (for the report + stale detection). */
export async function latestRun(db) {
  return db.prepare('SELECT * FROM eva_runs ORDER BY received_at DESC LIMIT 1').get()
}

export async function getAppRunsForRun(db, runRowId) {
  return db.prepare('SELECT * FROM eva_app_runs WHERE run_id = ? ORDER BY app_id').all(String(runRowId))
}

export async function getActionableFindings(db, { limit = 100 } = {}) {
  return db.prepare(
    `SELECT * FROM eva_findings
     WHERE lifecycle_state NOT IN ('resolved')
     ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
       last_seen_at DESC
     LIMIT ?`,
  ).all(Number(limit))
}

export async function getRecentlyResolved(db, { sinceIso, limit = 50 } = {}) {
  if (sinceIso) {
    return db.prepare(
      `SELECT * FROM eva_findings WHERE lifecycle_state = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT ?`,
    ).all(String(sinceIso), Number(limit))
  }
  return db.prepare(
    `SELECT * FROM eva_findings WHERE lifecycle_state = 'resolved' ORDER BY resolved_at DESC LIMIT ?`,
  ).all(Number(limit))
}

export async function getJourneyResult(db, id) {
  return db.prepare('SELECT * FROM eva_journey_results WHERE id = ? LIMIT 1').get(String(id))
}

export async function latestHeartbeat(db) {
  return db.prepare('SELECT * FROM eva_runner_heartbeats ORDER BY last_seen_at DESC LIMIT 1').get()
}
