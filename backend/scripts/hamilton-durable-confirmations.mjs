#!/usr/bin/env node
/**
 * hamilton-durable-confirmations.mjs — READ-ONLY census of DURABLE confirmed
 * submissions, computed THROUGH the canonical predicate
 * (`submissionProofPredicate.assessTaskSubmissionProof`), never by hand SQL.
 *
 * "Submitted" has two honest meanings (CLAUDE.md, owner North Star 2026-08-03):
 * externally submitted WITH retrievable proof, or an internal record. This
 * script answers, for every `application_tasks` row that reads `submitted`,
 * which one it is and WHY, using the exact code path the tracker/API/task
 * drawer use — so the number it prints is the number the product shows.
 *
 * Per-task disposition (one line each):
 *   durable_via_run            a status='submitted' autopilot run with a
 *                              retrievable hamilton_submission_confirmation
 *                              document or a classified-new portal reference
 *                              that passes the reference shape guard
 *   durable_via_receipt        an active, identity-bound manual receipt
 *   internal_only:<why>        the predicate's unverified_reason
 *                              (no_run_no_confirmation_doc,
 *                              run_without_captured_evidence,
 *                              output_document_is_<type>,
 *                              confirmation_document_not_bound_to_submitted_run, ...)
 *
 * It ALSO lists every hamilton_autopilot_runs row that reads `submitted` with
 * the evidence keys the predicate reads, and flags any stored
 * confirmation_reference that fails the engine's shape guard (the
 * "children-notification-children-notification" DOM-slug class, prod 2026-08-24).
 *
 * READ-ONLY: on Postgres the whole census runs inside ONE transaction opened
 * `SET TRANSACTION READ ONLY`, so a write anywhere in the predicate chain would
 * fail loudly instead of touching production. SQLite runs the same SELECT-only
 * chain directly. Nothing here mutates.
 *
 * Usage (the DB comes from the SAME env the backend uses — DATABASE_URL, or the
 * SQLite default when unset):
 *   DATABASE_URL='postgres://…' node backend/scripts/hamilton-durable-confirmations.mjs
 *   node backend/scripts/hamilton-durable-confirmations.mjs --json        # machine-readable
 *   node backend/scripts/hamilton-durable-confirmations.mjs --profile <id> # one profile
 *
 * Prod read-only: `railway variables --service Postgres --json` exposes
 * DATABASE_PUBLIC_URL (the service's DATABASE_URL is internal-only). Run from the
 * repo root so `pg` resolves.
 *
 * Exit code: 0 when the census ran; 2 on a usage/connection error. The count
 * itself is never an exit code — a zero is a true answer, not a failure.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assessTaskSubmissionProof,
  SUBMISSION_PROOF_STATE,
} from '../services/hamilton/submissionProofPredicate.js'
import { isDurableConfirmationReference } from '../services/hamilton/hamiltonConfirmationArtifacts.js'

/** Map a predicate verdict to the census disposition string. Pure. */
export function dispositionOf(proof) {
  if (!proof || proof.verified_external !== true) {
    const why = proof?.unverified_reason || (proof?.state === SUBMISSION_PROOF_STATE.NOT_SUBMITTED ? 'not_submitted' : 'unknown')
    return `internal_only:${why}`
  }
  if (proof.source === 'owner_attested_manual_receipt') return 'durable_via_receipt'
  return 'durable_via_run'
}

function safeJson(raw) {
  if (raw && typeof raw === 'object') return raw
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

async function tryAll(conn, sql, params = []) {
  try {
    const rows = await conn.prepare(sql).all(...params)
    return Array.isArray(rows) ? rows : []
  } catch {
    return null // table/column missing on this schema — reported, never fatal
  }
}

/**
 * Run the census against any `{ prepare(sql).all/get, dialect }` connection.
 * SELECT-only. Returns the machine-readable report.
 */
export async function runDurableConfirmationCensus(conn, { profileId = null } = {}) {
  const profileFilter = profileId ? ' AND t.profile_id = ?' : ''
  const profileParams = profileId ? [String(profileId)] : []

  const tasks = await tryAll(conn, `
    SELECT t.id, t.profile_id, t.opportunity_id, t.grant_id, t.status, t.current_step,
           t.output_document_id, t.submitted_at, t.updated_at
      FROM application_tasks t
     WHERE t.status = 'submitted'${profileFilter}
     ORDER BY t.submitted_at, t.id`, profileParams)
  if (tasks === null) {
    return { ok: false, error: 'application_tasks table is not readable on this database', submitted_rows: 0 }
  }

  // Titles are cosmetic; a bare schema without the catalog tables still censuses.
  const titleById = new Map()
  const oppIds = [...new Set(tasks.map((t) => t.opportunity_id).filter(Boolean))]
  const grantIds = [...new Set(tasks.map((t) => t.grant_id).filter(Boolean))]
  if (oppIds.length) {
    const rows = await tryAll(conn, `SELECT id, title FROM funding_opportunities WHERE id IN (${oppIds.map(() => '?').join(',')})`, oppIds)
    for (const r of rows || []) titleById.set(`opp:${r.id}`, r.title)
  }
  if (grantIds.length) {
    const rows = await tryAll(conn, `SELECT id, title FROM grants WHERE id IN (${grantIds.map(() => '?').join(',')})`, grantIds)
    for (const r of rows || []) titleById.set(`grant:${r.id}`, r.title)
  }

  const perTask = []
  const counts = { durable_via_run: 0, durable_via_receipt: 0, internal_only: 0 }
  const internalByReason = {}
  for (const t of tasks) {
    const proof = await assessTaskSubmissionProof(conn, {
      id: t.id, profile_id: t.profile_id, status: t.status, output_document_id: t.output_document_id ?? null,
    })
    const disposition = dispositionOf(proof)
    if (disposition === 'durable_via_run') counts.durable_via_run += 1
    else if (disposition === 'durable_via_receipt') counts.durable_via_receipt += 1
    else {
      counts.internal_only += 1
      const why = disposition.slice('internal_only:'.length)
      internalByReason[why] = (internalByReason[why] || 0) + 1
    }
    perTask.push({
      task_id: t.id,
      profile_id: t.profile_id,
      title: titleById.get(`opp:${t.opportunity_id}`) || titleById.get(`grant:${t.grant_id}`) || null,
      submitted_at: t.submitted_at ?? null,
      current_step: t.current_step ?? null,
      disposition,
      proof_source: proof.source,
      proof_document_id: proof.proof_document_id,
      proof_receipt_id: proof.proof_receipt_id,
      confirmation_reference: proof.confirmation_reference,
      output_document_kind: proof.output_document_kind,
    })
  }

  // Every run that CLAIMS submitted, with the evidence keys the read side judges.
  const submittedRuns = await tryAll(conn, `
    SELECT r.id, r.task_id, r.profile_id, r.status, r.confirmation_reference,
           r.confirmation_screenshot_path, r.result_json
      FROM hamilton_autopilot_runs r
     WHERE r.status = 'submitted'${profileId ? ' AND r.profile_id = ?' : ''}
     ORDER BY r.id`, profileParams)
  const runs = []
  for (const r of submittedRuns || []) {
    const result = safeJson(r.result_json)
    const reference = String(result.confirmation_reference || r.confirmation_reference || '').trim()
    runs.push({
      run_id: r.id,
      task_id: r.task_id,
      confirmation_evidence: result.confirmation_evidence ?? null,
      confirmation_reference: reference || null,
      reference_is_new: result.confirmation_reference_is_new === true,
      reference_passes_shape_guard: reference ? await isDurableConfirmationReference(reference) : null,
      received_acknowledgement_is_new: result.confirmation_received_acknowledgement_is_new === true,
      confirmation_document_id: result.confirmation_document_id ?? null,
      confirmation_page_document_id: result.confirmation_page_document_id ?? null,
      screenshot_path: r.confirmation_screenshot_path ?? null,
    })
  }

  // Any stored reference that fails the shape guard, on ANY run status.
  const referencedRuns = await tryAll(conn, `
    SELECT r.id, r.task_id, r.status, r.confirmation_reference
      FROM hamilton_autopilot_runs r
     WHERE r.confirmation_reference IS NOT NULL AND TRIM(r.confirmation_reference) <> ''${profileId ? ' AND r.profile_id = ?' : ''}
     ORDER BY r.id`, profileParams)
  const implausibleReferences = []
  for (const r of referencedRuns || []) {
    if (!(await isDurableConfirmationReference(r.confirmation_reference))) {
      implausibleReferences.push({ run_id: r.id, task_id: r.task_id, run_status: r.status, confirmation_reference: r.confirmation_reference })
    }
  }

  const durableTotal = counts.durable_via_run + counts.durable_via_receipt
  if (durableTotal + counts.internal_only !== tasks.length) {
    throw new Error(`census accounting broke: ${durableTotal} durable + ${counts.internal_only} internal != ${tasks.length} submitted rows`)
  }
  return {
    ok: true,
    computed_at: new Date().toISOString(),
    dialect: conn?.dialect || 'unknown',
    profile_id: profileId || null,
    submitted_rows: tasks.length,
    durable_via_run: counts.durable_via_run,
    durable_via_receipt: counts.durable_via_receipt,
    durable_confirmed_total: durableTotal,
    internal_only: counts.internal_only,
    internal_only_by_reason: internalByReason,
    submitted_runs: runs.length,
    submitted_runs_with_shape_valid_reference: runs.filter((r) => r.reference_passes_shape_guard === true).length,
    implausible_reference_runs: implausibleReferences.length,
    tasks: perTask,
    runs,
    implausible_references: implausibleReferences,
    tables_readable: { hamilton_autopilot_runs: submittedRuns !== null },
  }
}

function printHuman(report) {
  const out = []
  out.push(`Hamilton durable-confirmation census (${report.dialect}) @ ${report.computed_at}${report.profile_id ? ` — profile ${report.profile_id}` : ''}`)
  out.push(`submitted_rows=${report.submitted_rows} durable_via_run=${report.durable_via_run} durable_via_receipt=${report.durable_via_receipt} durable_confirmed_total=${report.durable_confirmed_total} internal_only=${report.internal_only}`)
  const reasons = Object.entries(report.internal_only_by_reason).sort((a, b) => b[1] - a[1])
  if (reasons.length) out.push(`internal_only by reason: ${reasons.map(([k, n]) => `${k}×${n}`).join(', ')}`)
  out.push('')
  out.push('per-task disposition:')
  for (const t of report.tasks) {
    out.push(`  ${t.task_id}  ${t.disposition}  profile=${t.profile_id}  submitted_at=${t.submitted_at || '-'}  step=${t.current_step || '-'}${t.confirmation_reference ? `  ref=${t.confirmation_reference}` : ''}${t.proof_document_id ? `  doc=${t.proof_document_id}` : ''}${t.title ? `  "${t.title}"` : ''}`)
  }
  out.push('')
  out.push(`hamilton_autopilot_runs status='submitted': ${report.submitted_runs} (${report.submitted_runs_with_shape_valid_reference} carry a shape-valid reference)`)
  for (const r of report.runs) {
    out.push(`  run ${r.run_id} task=${r.task_id} evidence=${r.confirmation_evidence || 'null'} ref=${r.confirmation_reference || 'null'}${r.confirmation_reference ? ` shape_ok=${r.reference_passes_shape_guard}` : ''} ref_new=${r.reference_is_new} ack_new=${r.received_acknowledgement_is_new} doc=${r.confirmation_document_id || r.confirmation_page_document_id || 'null'}`)
  }
  if (report.implausible_references.length) {
    out.push('')
    out.push(`stored confirmation_reference values that FAIL the shape guard (${report.implausible_references.length}):`)
    for (const r of report.implausible_references) out.push(`  run ${r.run_id} (${r.run_status}) task=${r.task_id} ref=${JSON.stringify(r.confirmation_reference)}`)
  }
  if (!report.tables_readable.hamilton_autopilot_runs) out.push('NOTE: hamilton_autopilot_runs is not readable on this database; run-level lines are empty.')
  return out.join('\n')
}

async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const profileIdx = argv.indexOf('--profile')
  const profileId = profileIdx >= 0 ? argv[profileIdx + 1] : null
  if (profileIdx >= 0 && !profileId) {
    console.error('--profile requires a profile id')
    process.exit(2)
  }

  // Imported lazily: `db/index.js` opens the configured database at import time.
  let db
  try {
    ;({ db } = await import('../db/index.js'))
  } catch (err) {
    console.error(`cannot open the configured database: ${err?.message || err}`)
    process.exit(2)
  }

  let report
  try {
    if (db.dialect === 'postgres' && typeof db.withTransaction === 'function') {
      report = await db.withTransaction(async (tx) => {
        await tx.prepare('SET TRANSACTION READ ONLY').run()
        return runDurableConfirmationCensus(tx, { profileId })
      })
    } else {
      report = await runDurableConfirmationCensus(db, { profileId })
    }
  } finally {
    try { await db.close?.() } catch { /* ignore */ }
  }

  if (!report.ok) {
    console.error(report.error)
    process.exit(2)
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : printHuman(report))
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  } catch { return false }
})()
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err))
    process.exit(2)
  })
}

export const _internal = { printHuman, scriptPath: fileURLToPath(import.meta.url) }
