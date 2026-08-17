/**
 * Canonical application lifecycle aggregate.
 *
 * One read joins the real opportunity, latest solicitation requirements,
 * Hamilton/manual tasks, application documents, durable document bytes,
 * section drafts, deadlines, grounded-coverage rows, submission proof, and
 * outcome evidence. Status presentation is evidence-aware: a raw `submitted`
 * flag is never promoted to verified external submission, and an awarded or
 * declined status without durable outcome evidence is labeled unverified.
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { loadStoredProfileEvidence } from './groundedDrafting.js'

export const OutcomeEvidenceInputSchema = z.object({
  application_id: z.string().trim().min(1).max(240),
  document_id: z.string().trim().min(1).max(240),
  outcome: z.enum(['awarded', 'declined', 'waitlisted', 'withdrawn']),
  response_received_at: z.string().datetime({ offset: true }),
  confirmation_reference: z.string().trim().max(500).nullable().optional(),
  attested_by_user_id: z.string().trim().min(1).max(240),
})

export const OutcomeEvidenceRevocationInputSchema = z.object({
  application_id: z.string().trim().min(1).max(240),
  evidence_id: z.string().trim().min(1).max(240),
  reason: z.string().trim().min(3).max(1_000),
  revoked_by_user_id: z.string().trim().min(1).max(240),
})

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function isMissingTableError(error) {
  return /no such table|does not exist/i.test(String(error?.message || ''))
}

async function optionalGet(db, sql, ...params) {
  try { return await db.prepare(sql).get(...params) } catch (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
}

async function optionalAll(db, sql, ...params) {
  try { return await db.prepare(sql).all(...params) } catch (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
}

async function runInTransaction(db, work) {
  if (typeof db?.withTransaction === 'function') return db.withTransaction(work)
  return work(db)
}

async function deriveTask(db, { profileId, opportunityId, pipelineGrantId }) {
  if (opportunityId) {
    const byOpportunity = await optionalGet(
      db,
      `SELECT * FROM application_tasks
        WHERE profile_id = ? AND opportunity_id = ?
        ORDER BY updated_at DESC LIMIT 1`,
      profileId,
      opportunityId,
    )
    if (byOpportunity) return { task: byOpportunity, basis: 'profile_opportunity' }
  }
  if (pipelineGrantId) {
    const byGrant = await optionalGet(
      db,
      `SELECT * FROM application_tasks
        WHERE profile_id = ? AND grant_id = ?
        ORDER BY updated_at DESC LIMIT 1`,
      profileId,
      pipelineGrantId,
    )
    if (byGrant) return { task: byGrant, basis: 'profile_pipeline_grant' }
  }
  return { task: null, basis: 'none' }
}

/** Create/update the explicit subject link; this is the only canonical linker. */
export async function linkApplicationLifecycle(db, {
  applicationId,
  canonicalTaskId = null,
  solicitationId = null,
} = {}) {
  if (!applicationId) throw new Error('applicationId is required')
  const application = await db.prepare(
    `SELECT a.*,
            COALESCE(a.opportunity_id, g.funding_opportunity_id) AS resolved_opportunity_id,
            COALESCE(a.pipeline_grant_id, g.id) AS resolved_pipeline_grant_id,
            g.profile_id AS pipeline_grant_profile_id
       FROM grant_applications a
       LEFT JOIN grants g ON g.id = a.pipeline_grant_id
      WHERE a.id = ? LIMIT 1`,
  ).get(applicationId)
  if (!application) {
    const error = new Error('Application not found')
    error.code = 'APPLICATION_NOT_FOUND'
    error.status = 404
    throw error
  }
  if (
    application.pipeline_grant_profile_id
    && String(application.pipeline_grant_profile_id) !== String(application.profile_id)
  ) {
    const error = new Error('Application pipeline grant belongs to a different profile')
    error.code = 'APPLICATION_PIPELINE_SCOPE_MISMATCH'
    error.status = 403
    throw error
  }

  let taskId = canonicalTaskId
  if (taskId) {
    const task = await db.prepare(
      'SELECT id, profile_id, opportunity_id, grant_id FROM application_tasks WHERE id = ? LIMIT 1',
    ).get(taskId)
    if (!task) {
      const error = new Error('Canonical task not found')
      error.code = 'CANONICAL_TASK_NOT_FOUND'
      error.status = 404
      throw error
    }
    const sameProfile = String(task.profile_id || '') === String(application.profile_id || '')
    const taskOpportunity = task.opportunity_id ? String(task.opportunity_id) : null
    const taskGrant = task.grant_id ? String(task.grant_id) : null
    const applicationOpportunity = application.resolved_opportunity_id
      ? String(application.resolved_opportunity_id)
      : null
    const applicationGrant = application.resolved_pipeline_grant_id
      ? String(application.resolved_pipeline_grant_id)
      : null
    const crossOpportunity = Boolean(taskOpportunity && applicationOpportunity && taskOpportunity !== applicationOpportunity)
    const sameSubject = Boolean(
      (applicationOpportunity && taskOpportunity === applicationOpportunity)
      || (applicationGrant && taskGrant === applicationGrant),
    )
    if (!sameProfile || crossOpportunity || !sameSubject) {
      const error = new Error('Canonical task does not belong to this application profile/opportunity')
      error.code = 'CANONICAL_TASK_SCOPE_MISMATCH'
      error.status = 403
      throw error
    }
  } else {
    const derived = await deriveTask(db, {
      profileId: application.profile_id,
      opportunityId: application.resolved_opportunity_id,
      pipelineGrantId: application.resolved_pipeline_grant_id,
    })
    taskId = derived.task?.id || null
  }

  let resolvedSolicitationId = solicitationId
  if (resolvedSolicitationId) {
    const solicitation = await db.prepare(
      'SELECT id, profile_id, opportunity_id FROM opportunity_solicitations WHERE id = ? LIMIT 1',
    ).get(resolvedSolicitationId)
    if (!solicitation) {
      const error = new Error('Solicitation not found')
      error.code = 'SOLICITATION_NOT_FOUND'
      error.status = 404
      throw error
    }
    if (
      String(solicitation.profile_id || '') !== String(application.profile_id || '')
      || !application.resolved_opportunity_id
      || String(solicitation.opportunity_id || '') !== String(application.resolved_opportunity_id)
    ) {
      const error = new Error('Solicitation does not belong to this application profile/opportunity')
      error.code = 'SOLICITATION_SCOPE_MISMATCH'
      error.status = 403
      throw error
    }
  } else if (application.resolved_opportunity_id) {
    const solicitation = await optionalGet(
      db,
      `SELECT id FROM opportunity_solicitations
        WHERE profile_id = ? AND opportunity_id = ?
        ORDER BY updated_at DESC LIMIT 1`,
      application.profile_id,
      application.resolved_opportunity_id,
    )
    resolvedSolicitationId = solicitation?.id || null
  }

  await db.prepare(
    `INSERT INTO application_lifecycle_subjects
      (application_id, profile_id, opportunity_id, pipeline_grant_id, canonical_task_id, solicitation_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(application_id) DO UPDATE SET
       profile_id = excluded.profile_id,
       opportunity_id = excluded.opportunity_id,
       pipeline_grant_id = excluded.pipeline_grant_id,
       canonical_task_id = COALESCE(excluded.canonical_task_id, application_lifecycle_subjects.canonical_task_id),
       solicitation_id = COALESCE(excluded.solicitation_id, application_lifecycle_subjects.solicitation_id),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    application.id,
    application.profile_id,
    application.resolved_opportunity_id ?? null,
    application.resolved_pipeline_grant_id ?? null,
    taskId,
    resolvedSolicitationId,
  )
  return db.prepare('SELECT * FROM application_lifecycle_subjects WHERE application_id = ?').get(application.id)
}

async function assessSubmissionProof(db, task) {
  if (!task || String(task.status || '').toLowerCase() !== 'submitted') {
    return {
      verified_external: false,
      state: 'not_submitted',
      label: 'Not submitted',
      source: 'none',
    }
  }

  // Reuse the repository's single canonical predicate when the full Hamilton
  // subsystem is present. The fallback below is intentionally fail-closed for
  // rolling migrations and focused test databases.
  try {
    const module = await import('./hamilton/submissionProofPredicate.js')
    if (typeof module.assessTaskSubmissionProof === 'function') {
      return await module.assessTaskSubmissionProof(db, task)
    }
  } catch (error) {
    if (!isMissingTableError(error) && error?.code !== 'ERR_MODULE_NOT_FOUND') {
      // Missing optional proof dependencies fail closed too; never let a read
      // outage turn an internal flag into verified submission.
    }
  }

  const receipt = await optionalGet(
    db,
    `SELECT id, document_id, confirmation_reference, submitted_at
       FROM hamilton_manual_submission_receipts
      WHERE task_id = ? AND profile_id = ? AND status = 'active'
      ORDER BY attested_at DESC LIMIT 1`,
    task.id,
    task.profile_id,
  )
  if (receipt) {
    return {
      verified_external: true,
      state: 'externally_submitted_with_proof',
      label: 'Externally submitted — owner-attested portal confirmation on file',
      source: 'owner_attested_manual_receipt',
      proof_receipt_id: receipt.id,
      proof_document_id: receipt.document_id,
      confirmation_reference: receipt.confirmation_reference || null,
      submitted_at: receipt.submitted_at,
    }
  }
  return {
    verified_external: false,
    state: 'marked_submitted_internal',
    label: 'Marked submitted (internal record — not confirmed sent to the funder)',
    source: 'none',
    unverified_reason: 'no_retrievable_submission_proof',
  }
}

function deriveTruthfulState({ application, task, submissionProof, outcomeEvidence }) {
  if (outcomeEvidence?.status === 'active') {
    if (outcomeEvidence.outcome === 'waitlisted') {
      return {
        current_state: 'waitlisted_verified',
        terminal: false,
        terminal_state: null,
        label: 'Waitlisted — response evidence on file',
      }
    }
    return {
      current_state: `${outcomeEvidence.outcome}_verified`,
      terminal: true,
      terminal_state: outcomeEvidence.outcome,
      label: `${outcomeEvidence.outcome[0].toUpperCase()}${outcomeEvidence.outcome.slice(1)} — response evidence on file`,
    }
  }

  const raw = String(application?.status || task?.status || 'draft').toLowerCase()
  if (['awarded', 'denied', 'declined', 'withdrawn'].includes(raw)) {
    return {
      current_state: 'outcome_recorded_unverified',
      terminal: false,
      terminal_state: null,
      label: `${raw} recorded, but no durable outcome evidence is linked`,
      unverified_outcome: raw,
    }
  }
  if (submissionProof?.verified_external) {
    return {
      current_state: 'submitted_verified',
      terminal: false,
      terminal_state: null,
      label: submissionProof.label,
    }
  }
  if (submissionProof?.state === 'marked_submitted_internal' || raw === 'submitted') {
    return {
      current_state: 'marked_submitted_internal',
      terminal: false,
      terminal_state: null,
      label: 'Marked submitted internally — external transmission is unverified',
    }
  }
  return { current_state: raw, terminal: false, terminal_state: null, label: raw.replaceAll('_', ' ') }
}

function groupRequirementRows(rows) {
  const grouped = new Map()
  for (const row of rows || []) {
    let requirement = grouped.get(row.id)
    if (!requirement) {
      requirement = {
        id: row.id,
        version_id: row.version_id,
        canonical_key: row.canonical_key,
        requirement_type: row.requirement_type,
        title: row.title,
        requirement_text: row.requirement_text,
        normalized_value: parseJson(row.normalized_value_json, {}),
        mandatory: row.mandatory === true || row.mandatory === 1,
        status: row.status,
        citations: [],
      }
      grouped.set(row.id, requirement)
    }
    if (row.citation_id) {
      requirement.citations.push({
        id: row.citation_id,
        quote_text: row.quote_text,
        char_start: row.char_start,
        char_end: row.char_end,
        page_number: row.page_number,
        source_url: row.source_url,
        chunk_index: row.chunk_index,
      })
    }
  }
  return [...grouped.values()]
}

export async function loadApplicationLifecycle(db, applicationId) {
  if (!applicationId) throw new Error('applicationId is required')
  const application = await db.prepare('SELECT * FROM grant_applications WHERE id = ? LIMIT 1').get(applicationId)
  if (!application) return null

  const subject = await optionalGet(
    db,
    'SELECT * FROM application_lifecycle_subjects WHERE application_id = ? LIMIT 1',
    applicationId,
  )
  const opportunityId = subject?.opportunity_id || application.opportunity_id || null
  const pipelineGrantId = subject?.pipeline_grant_id || application.pipeline_grant_id || null
  const opportunity = opportunityId
    ? await optionalGet(db, 'SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1', opportunityId)
    : null

  let task = subject?.canonical_task_id
    ? await optionalGet(db, 'SELECT * FROM application_tasks WHERE id = ? AND profile_id = ? LIMIT 1', subject.canonical_task_id, application.profile_id)
    : null
  let taskJoinBasis = task ? 'explicit_lifecycle_subject' : 'none'
  if (!task) {
    const derived = await deriveTask(db, {
      profileId: application.profile_id,
      opportunityId,
      pipelineGrantId,
    })
    task = derived.task
    taskJoinBasis = derived.basis
  }

  let solicitation = null
  if (subject?.solicitation_id) {
    solicitation = await optionalGet(
      db,
      `SELECT s.*, v.id AS latest_version_id, v.version_number, v.source_sha256,
              v.extracted_chars, v.chunk_count, v.created_at AS version_created_at
         FROM opportunity_solicitations s
         LEFT JOIN solicitation_versions v ON v.id = (
           SELECT v2.id FROM solicitation_versions v2
            WHERE v2.solicitation_id = s.id ORDER BY v2.version_number DESC LIMIT 1
         )
        WHERE s.id = ? AND s.profile_id = ? LIMIT 1`,
      subject.solicitation_id,
      application.profile_id,
    )
  }
  if (!solicitation && opportunityId) {
    solicitation = await optionalGet(
      db,
      `SELECT s.*, v.id AS latest_version_id, v.version_number, v.source_sha256,
              v.extracted_chars, v.chunk_count, v.created_at AS version_created_at
         FROM opportunity_solicitations s
         LEFT JOIN solicitation_versions v ON v.id = (
           SELECT v2.id FROM solicitation_versions v2
            WHERE v2.solicitation_id = s.id ORDER BY v2.version_number DESC LIMIT 1
         )
        WHERE s.profile_id = ? AND s.opportunity_id = ?
        ORDER BY s.updated_at DESC LIMIT 1`,
      application.profile_id,
      opportunityId,
    )
  }

  const requirementRows = solicitation?.latest_version_id
    ? await optionalAll(
        db,
        `SELECT r.*, c.id AS citation_id, c.quote_text, c.char_start, c.char_end,
                c.page_number, c.source_url, ch.chunk_index
           FROM solicitation_requirements r
           LEFT JOIN requirement_citations c ON c.requirement_id = r.id
           LEFT JOIN solicitation_chunks ch ON ch.id = c.chunk_id
          WHERE r.version_id = ?
          ORDER BY r.requirement_type, r.canonical_key, c.char_start`,
        solicitation.latest_version_id,
      )
    : []

  const [steps, applicationDocuments, deadlines, submissions, coverage] = await Promise.all([
    optionalAll(db, 'SELECT * FROM application_steps WHERE application_id = ? ORDER BY step_order, created_at', applicationId),
    optionalAll(db, 'SELECT * FROM application_documents WHERE application_id = ? ORDER BY uploaded_at', applicationId),
    optionalAll(db, 'SELECT * FROM deadline_events WHERE application_id = ? ORDER BY due_at', applicationId),
    optionalAll(db, 'SELECT * FROM submission_events WHERE application_id = ? ORDER BY occurred_at', applicationId),
    optionalAll(db, 'SELECT * FROM draft_requirement_coverage WHERE application_id = ? ORDER BY requirement_id', applicationId),
  ])
  const durableDocuments = pipelineGrantId
    ? await optionalAll(
        db,
        `SELECT id, name, type, file_size, mime_type, content_hash, status, version,
                created_at, updated_at,
                CASE WHEN file_bytes IS NULL THEN 0 ELSE 1 END AS bytes_retrievable
           FROM documents WHERE grant_id = ? ORDER BY updated_at DESC`,
        pipelineGrantId,
      )
    : []
  const drafts = pipelineGrantId
    ? await optionalAll(db, 'SELECT * FROM application_drafts WHERE grant_id = ? ORDER BY section_order, updated_at', pipelineGrantId)
    : []
  const amendmentChanges = solicitation?.latest_version_id
    ? await optionalAll(
        db,
        'SELECT * FROM solicitation_amendment_diffs WHERE to_version_id = ? ORDER BY change_type, canonical_key',
        solicitation.latest_version_id,
      )
    : []
  const outcomeEvidence = await optionalGet(
    db,
    `SELECT * FROM application_outcome_evidence
      WHERE application_id = ? AND profile_id = ? AND status = 'active'
      ORDER BY attested_at DESC LIMIT 1`,
    applicationId,
    application.profile_id,
  )
  const submissionProof = await assessSubmissionProof(db, task)
  const state = deriveTruthfulState({ application, task, submissionProof, outcomeEvidence })
  const profileEvidence = await loadStoredProfileEvidence(db, application.profile_id)

  return {
    application,
    subject: {
      application_id: applicationId,
      profile_id: application.profile_id,
      opportunity_id: opportunityId,
      pipeline_grant_id: pipelineGrantId,
      canonical_task_id: task?.id || null,
      solicitation_id: solicitation?.id || null,
      persisted: Boolean(subject),
      task_join_basis: taskJoinBasis,
    },
    opportunity,
    solicitation: solicitation ? {
      ...solicitation,
      requirements: groupRequirementRows(requirementRows),
      amendment_changes: amendmentChanges.map((row) => ({
        ...row,
        before: parseJson(row.before_json, null),
        after: parseJson(row.after_json, null),
      })),
    } : null,
    workflow: {
      steps,
      task,
      deadlines,
    },
    documents: {
      checklist_and_uploads: applicationDocuments,
      durable_artifacts: durableDocuments,
    },
    drafts,
    requirement_coverage: coverage.map((row) => ({
      ...row,
      applicant_evidence: parseJson(row.applicant_evidence_json, []),
      requirement_citations: parseJson(row.requirement_citations_json, []),
      unsupported_claims: parseJson(row.unsupported_claims_json, []),
    })),
    grounding_evidence_sources: profileEvidence.sources.map((source) => ({
      source_type: source.source_type,
      source_id: source.source_id,
      label: source.label || source.source_id,
      value: source.value,
    })),
    submission: {
      events: submissions,
      proof: submissionProof,
    },
    outcome: outcomeEvidence ? {
      verified: true,
      ...outcomeEvidence,
    } : {
      verified: false,
      recorded_status: ['awarded', 'denied', 'declined', 'withdrawn'].includes(String(application.status || '').toLowerCase())
        ? application.status
        : null,
    },
    state,
  }
}

function documentEvidenceHash(document) {
  const stored = String(document?.content_hash || '').trim().toLowerCase()
  if (/^[a-f0-9]{64}$/.test(stored)) return stored
  if (Buffer.isBuffer(document?.file_bytes) && document.file_bytes.length > 0) {
    return createHash('sha256').update(document.file_bytes).digest('hex')
  }
  return null
}

/** Record a durable outcome and synchronize legacy status fields only after proof exists. */
export async function recordApplicationOutcomeEvidence(db, rawInput) {
  const input = OutcomeEvidenceInputSchema.parse(rawInput)
  return runInTransaction(db, async (tx) => {
    const application = await tx.prepare('SELECT * FROM grant_applications WHERE id = ? LIMIT 1').get(input.application_id)
    if (!application) {
      const error = new Error('Application not found')
      error.code = 'APPLICATION_NOT_FOUND'
      error.status = 404
      throw error
    }
    const document = await tx.prepare(
      `SELECT id, profile_id, grant_id, content_hash, file_bytes, type, mime_type
         FROM documents WHERE id = ? LIMIT 1`,
    ).get(input.document_id)
    if (!document) {
      const error = new Error('Outcome evidence document not found')
      error.code = 'OUTCOME_DOCUMENT_NOT_FOUND'
      error.status = 404
      throw error
    }
    const belongsToProfile = document.profile_id
      && String(document.profile_id) === String(application.profile_id)
    const grantScopeMatches = !document.grant_id || (
      application.pipeline_grant_id
      && String(document.grant_id) === String(application.pipeline_grant_id)
    )
    if (!belongsToProfile || !grantScopeMatches) {
      const error = new Error('Outcome document is not linked to the application profile or grant')
      error.code = 'OUTCOME_DOCUMENT_SCOPE_MISMATCH'
      error.status = 403
      throw error
    }
    const evidenceHash = documentEvidenceHash(document)
    if (!evidenceHash) {
      const error = new Error('Outcome evidence must have durable bytes or a verified SHA-256 content hash')
      error.code = 'OUTCOME_DOCUMENT_NOT_DURABLE'
      error.status = 422
      throw error
    }

    const active = await tx.prepare(
      `SELECT * FROM application_outcome_evidence
        WHERE application_id = ? AND status = 'active' LIMIT 1`,
    ).get(application.id)
    if (active) {
      if (active.evidence_sha256 === evidenceHash && active.outcome === input.outcome) {
        return { evidence: active, duplicate: true }
      }
      const error = new Error('An active outcome evidence record already exists; revoke it explicitly before replacing it')
      error.code = 'OUTCOME_EVIDENCE_ALREADY_ACTIVE'
      error.status = 409
      throw error
    }

    const id = randomUUID()
    const now = new Date().toISOString()
    await tx.prepare(
      `INSERT INTO application_outcome_evidence
        (id, application_id, profile_id, document_id, outcome, response_received_at,
         confirmation_reference, attested_by_user_id, attested_at, evidence_sha256, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      id,
      application.id,
      application.profile_id,
      document.id,
      input.outcome,
      input.response_received_at,
      input.confirmation_reference ?? null,
      input.attested_by_user_id,
      now,
      evidenceHash,
    )

    const legacyStatus = input.outcome === 'declined'
      ? 'denied'
      : input.outcome === 'waitlisted'
        ? 'under_review'
        : input.outcome
    await tx.prepare(
      `UPDATE grant_applications
          SET status = ?, response_received_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(legacyStatus, input.response_received_at, now, application.id)

    // The canonical pipeline enum has no truthful `withdrawn` state. Never
    // collapse a user-withdrawn application into `archived` (which means a
    // lifecycle/filing action, not applicant withdrawal). The verified outcome
    // remains canonical in application_outcome_evidence + grant_applications;
    // pipeline status is synchronized only where its vocabulary is exact.
    if (application.pipeline_grant_id && ['awarded', 'declined'].includes(input.outcome)) {
      const pipelineStatus = input.outcome
      await tx.prepare(
        `UPDATE grants SET status = ?, updated_at = ? WHERE id = ? AND profile_id = ?`,
      ).run(pipelineStatus, now, application.pipeline_grant_id, application.profile_id)
    }

    const evidence = await tx.prepare('SELECT * FROM application_outcome_evidence WHERE id = ?').get(id)
    return { evidence, duplicate: false }
  })
}

/**
 * Revoke a mistaken or rescinded outcome assertion without erasing history.
 * The database trigger permits only this one-way transition; replacement proof
 * is then appended through recordApplicationOutcomeEvidence.
 */
export async function revokeApplicationOutcomeEvidence(db, rawInput) {
  const input = OutcomeEvidenceRevocationInputSchema.parse(rawInput)
  return runInTransaction(db, async (tx) => {
    const application = await tx.prepare(
      'SELECT id, profile_id, pipeline_grant_id, status FROM grant_applications WHERE id = ? LIMIT 1',
    ).get(input.application_id)
    if (!application) {
      const error = new Error('Application not found')
      error.code = 'APPLICATION_NOT_FOUND'
      error.status = 404
      throw error
    }
    const evidence = await tx.prepare(
      `SELECT * FROM application_outcome_evidence
        WHERE id = ? AND application_id = ? AND profile_id = ? LIMIT 1`,
    ).get(input.evidence_id, application.id, application.profile_id)
    if (!evidence) {
      const error = new Error('Outcome evidence not found for this application')
      error.code = 'OUTCOME_EVIDENCE_NOT_FOUND'
      error.status = 404
      throw error
    }
    if (evidence.status !== 'active') {
      const error = new Error('Outcome evidence is already revoked')
      error.code = 'OUTCOME_EVIDENCE_ALREADY_REVOKED'
      error.status = 409
      throw error
    }

    const revokedAt = new Date().toISOString()
    const updated = await tx.prepare(
      `UPDATE application_outcome_evidence
          SET status = 'revoked', revoked_at = ?, revocation_reason = ?, revoked_by_user_id = ?
        WHERE id = ? AND application_id = ? AND profile_id = ? AND status = 'active'`,
    ).run(
      revokedAt,
      input.reason,
      input.revoked_by_user_id,
      evidence.id,
      application.id,
      application.profile_id,
    )
    if (Number(updated?.changes || 0) !== 1) {
      const error = new Error('Outcome evidence changed before it could be revoked')
      error.code = 'OUTCOME_EVIDENCE_REVOKE_CONFLICT'
      error.status = 409
      throw error
    }

    const legacyOutcomeStatus = evidence.outcome === 'declined'
      ? 'denied'
      : evidence.outcome === 'waitlisted'
        ? 'under_review'
        : evidence.outcome
    await tx.prepare(
      `UPDATE grant_applications
          SET status = 'under_review', updated_at = ?
        WHERE id = ? AND profile_id = ? AND status = ?`,
    ).run(revokedAt, application.id, application.profile_id, legacyOutcomeStatus)

    // Only unwind the terminal pipeline stage that this exact assertion could
    // have written. A later/manual state is never overwritten.
    if (application.pipeline_grant_id && ['awarded', 'declined'].includes(evidence.outcome)) {
      await tx.prepare(
        `UPDATE grants SET status = 'follow_up', updated_at = ?
          WHERE id = ? AND profile_id = ? AND status = ?`,
      ).run(
        revokedAt,
        application.pipeline_grant_id,
        application.profile_id,
        evidence.outcome,
      )
    }

    return {
      evidence: await tx.prepare('SELECT * FROM application_outcome_evidence WHERE id = ?').get(evidence.id),
      revoked: true,
    }
  })
}

export const _internal = {
  assessSubmissionProof,
  deriveTruthfulState,
  documentEvidenceHash,
  groupRequirementRows,
}

export default {
  linkApplicationLifecycle,
  loadApplicationLifecycle,
  recordApplicationOutcomeEvidence,
  revokeApplicationOutcomeEvidence,
}
