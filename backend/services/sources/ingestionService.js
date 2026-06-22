/**
 * Ingestion Service
 * Handles ingestion of opportunities from various sources into the database.
 * Pre-filters through opportunity policy before DB writes.
 */

import crypto from 'crypto';
import { enforceOpportunityPolicy } from '../shared/opportunityPolicy.js';
import { validateOpportunity } from '../opportunityValidator.js';
import { reviewOpportunity } from '../reviewerAgent.js';
import { assessReality } from '../opportunityRealityGate.js';
import {
  evaluateProvenance,
  recordRejection,
  deriveEvidenceUrl,
  persistEvidence,
} from '../provenanceAudit.js';
import { createLogger } from '../../utils/logger.js'

function isActiveFlag(value) {
  return value === 1 || value === true || value === '1' || value === 'true';
}
const log = createLogger('ingestionService')

/**
 * Ingest opportunities into the database
 * @param {object} db - Database connection
 * @param {array} opportunities - Array of normalized opportunities
 * @param {string} sourceName - Source name for tracking
 * @returns {object} Ingestion results
 */
export async function ingestOpportunities(db, opportunities, sourceName) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  
  log.info(`[ingestion] Starting ingestion run ${runId} for source: ${sourceName}`);
  
  // Create ingestion run record
  const createRun = db.prepare(`
    INSERT INTO ingestion_runs (id, source, started_at, status, records_fetched)
    VALUES (?, ?, ?, 'running', ?)
  `);
  
  await createRun.run(runId, sourceName, startedAt, opportunities.length);
  
  let inserted = 0;
  let updated = 0;
  let errors = 0;
  const errorMessages = [];
  
  // IMPORTANT:
  // We cannot rely on `ON CONFLICT (source, source_id)` because some deployments use
  // a PARTIAL unique index (WHERE source/source_id IS NOT NULL), which does not satisfy
  // ON CONFLICT inference in SQLite/Postgres.
  // Instead we do deterministic insert-or-update using a preflight existence check.
  const insertStmt = db.prepare(`
    INSERT INTO funding_opportunities (
      id, source, source_id, title, sponsor, description,
      application_url, source_url, deadline, deadline_type,
      amount_min, amount_max, amount_description,
      is_national, state,
      categories, keywords, eligibility_bullets,
      requires_match, requires_501c3, match_percentage,
      opportunity_type, is_active, raw_source_payload, last_crawled,
      opportunity_kind, source_trust_tier, reality_status, reality_reasons,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);

  const updateStmt = db.prepare(`
    UPDATE funding_opportunities
    SET
      title = ?,
      sponsor = ?,
      description = ?,
      application_url = ?,
      source_url = ?,
      deadline = ?,
      deadline_type = ?,
      amount_min = ?,
      amount_max = ?,
      amount_description = ?,
      is_national = ?,
      state = ?,
      categories = ?,
      keywords = ?,
      eligibility_bullets = ?,
      requires_match = ?,
      requires_501c3 = ?,
      match_percentage = ?,
      opportunity_type = ?,
      is_active = ?,
      raw_source_payload = ?,
      last_crawled = ?,
      opportunity_kind = COALESCE(?, opportunity_kind),
      source_trust_tier = COALESCE(?, source_trust_tier),
      reality_status = COALESCE(?, reality_status),
      reality_reasons = COALESCE(?, reality_reasons),
      updated_at = CURRENT_TIMESTAMP
    WHERE source = ? AND source_id = ?
  `);
  
  // Check if record exists to determine if it's insert or update
  const checkExists = db.prepare(
    'SELECT id FROM funding_opportunities WHERE source = ? AND source_id = ?'
  );
  
  // Best-effort rejection logger — mirrors opportunityInserter so every gate
  // that drops a row is observable via /api/admin/rejections. Never throws.
  const logReject = async (opp, stage, reason) => {
    try {
      await recordRejection(db, {
        source: opp?.source ?? sourceName ?? null,
        source_url: deriveEvidenceUrl(opp),
        title: opp?.title ?? null,
        reason,
        stage,
        raw_meta: { record_origin: opp?.record_origin ?? null, run_id: runId },
      });
    } catch {
      /* recordRejection is already best-effort */
    }
  };

  // Pre-filter through provenance, policy, validation, and the reviewer agent
  // before touching DB.
  let policySkipped = 0;
  let reviewerSkipped = 0;
  let realitySkipped = 0;
  const validated = [];
  for (const opp of opportunities) {
    // MANDATORY source-registry / provenance check — no random junk. Unknown
    // or untrusted provenance is rejected + logged rather than silently stored.
    const provenance = evaluateProvenance(opp);
    if (!provenance.allowed) {
      policySkipped++;
      console.warn(`[ingestion] Provenance rejection: ${provenance.reason} | ${opp?.title ?? 'untitled'}`);
      await logReject(opp, 'provenance', provenance.reason);
      continue;
    }
    const policy = enforceOpportunityPolicy(opp);
    if (!policy.ok) {
      policySkipped++;
      console.warn(`[ingestion] Policy rejection: ${policy.reason} | ${opp?.title ?? 'untitled'}`);
      await logReject(opp, 'policy', `policy:${policy.reason}`);
      continue;
    }
    const v = validateOpportunity(opp, { allowDirectories: true });
    if (!v.valid) {
      policySkipped++;
      console.warn(`[ingestion] Validation rejection: ${v.errors.join(',')} | ${opp?.title ?? 'untitled'}`);
      await logReject(opp, 'validation', `validation:${v.errors.join(',')}`);
      continue;
    }
    const review = reviewOpportunity(opp);
    if (!review.ok) {
      reviewerSkipped++;
      console.warn(`[ingestion] Reviewer rejection: ${review.reason} | ${opp?.title ?? 'untitled'}`);
      await logReject(opp, 'reviewer', `reviewer:${review.reason}`);
      continue;
    }
    // CANONICAL REALITY GATE (Mission System 1): the government-import path must
    // not bypass the single reality gate that every user-visible opportunity
    // passes through. We gate rows destined to be ACTIVE/user-visible. Rows
    // explicitly ingested as inactive reference data (e.g. USAspending past
    // awards, is_active=0) are reference-only and never surfaced as live
    // opportunities, so they are exempt from the live-opportunity gate.
    const willBeActive = opp.is_active === null || opp.is_active === undefined
      ? true
      : isActiveFlag(opp.is_active);
    if (willBeActive) {
      const reality = assessReality(opp);
      if (!reality.allowed) {
        realitySkipped++;
        console.warn(`[ingestion] Reality-gate rejection: ${reality.reasons.join(',')} | ${opp?.title ?? 'untitled'}`);
        await logReject(opp, 'reality', `reality:${reality.reasons[0] ?? 'unknown'}`);
        continue;
      }
      // PERSIST the canonical verdict (RC-8). Previously this path gated on
      // reality but discarded the result, leaving reality_status = NULL so the
      // persisted-verdict fast path in opportunityTrust.js could not use it.
      // Mirror opportunityInserter's mapping so both writers agree.
      opp.opportunity_kind = reality.kind ?? opp.opportunity_kind ?? null;
      opp.source_trust_tier = reality.trustTier ?? opp.source_trust_tier ?? null;
      opp.reality_status = reality.downgrade ? 'downgraded' : 'allowed';
      opp.reality_reasons = JSON.stringify(Array.isArray(reality.reasons) ? reality.reasons : []);
    }
    // Normalize required DB fields that upstream adapters sometimes omit
    // (NIH RePORTER, older connectors). funding_opportunities.id is a
    // non-null primary key so we generate a stable UUID here when missing.
    if (!opp.id) {
      opp.id = crypto.randomUUID();
    }
    if ((opp.last_crawled === null || opp.last_crawled === undefined)) {
      opp.last_crawled = new Date().toISOString();
    }
    if ((opp.is_active === null || opp.is_active === undefined)) {
      opp.is_active = 1;
    }
    // Normalize JSON-array columns to TEXT before binding. Adapters are
    // inconsistent: SAM.gov / USASpending pre-stringify these, but
    // transformGrantsGovOpportunity (and some others) return raw arrays.
    // better-sqlite3 cannot bind arrays/objects, so an un-stringified field
    // would throw per-row inside the transaction and silently drop the record.
    // Stringify here (after all gates) so every adapter persists correctly.
    for (const col of ['categories', 'keywords', 'eligibility_bullets']) {
      const v = opp[col];
      if (v !== null && v !== undefined && typeof v !== 'string') {
        opp[col] = JSON.stringify(v);
      }
    }
    validated.push(opp);
  }
  if (policySkipped > 0) {
    log.info(`[ingestion] Pre-filtered ${policySkipped} opportunities by policy/validation`);
  }
  if (reviewerSkipped > 0) {
    log.info(`[ingestion] Pre-filtered ${reviewerSkipped} opportunities by reviewer agent`);
  }
  if (realitySkipped > 0) {
    log.info(`[ingestion] Pre-filtered ${realitySkipped} opportunities by canonical reality gate`);
  }

  // Process in a transaction for performance
  const ingest = db.transaction(() => {
    for (const opp of validated) {
      try {
        // Check if exists before upsert to track insert vs update
        // Validate input parameters before SQL execution
if (!opp.source || !opp.source_id) {
  throw new Error('Invalid opportunity: missing source or source_id');
}
const existing = checkExists.get(opp.source, opp.source_id);

        if (existing) {
          updateStmt.run(
            opp.title,
            opp.sponsor,
            opp.description,
            opp.application_url,
            opp.source_url,
            opp.deadline,
            opp.deadline_type,
            opp.amount_min,
            opp.amount_max,
            opp.amount_description,
            opp.is_national,
            opp.state,
            opp.categories,
            opp.keywords,
            opp.eligibility_bullets,
            opp.requires_match,
            opp.requires_501c3,
            opp.match_percentage,
            opp.opportunity_type,
            opp.is_active,
            opp.raw_source_payload,
            opp.last_crawled,
            opp.opportunity_kind ?? null,
            opp.source_trust_tier ?? null,
            opp.reality_status ?? null,
            opp.reality_reasons ?? null,
            opp.source,
            opp.source_id,
          );
          updated++;
        } else {
          insertStmt.run(
            opp.id,
            opp.source,
            opp.source_id,
            opp.title,
            opp.sponsor,
            opp.description,
            opp.application_url,
            opp.source_url,
            opp.deadline,
            opp.deadline_type,
            opp.amount_min,
            opp.amount_max,
            opp.amount_description,
            opp.is_national,
            opp.state,
            opp.categories,
            opp.keywords,
            opp.eligibility_bullets,
            opp.requires_match,
            opp.requires_501c3,
            opp.match_percentage,
            opp.opportunity_type,
            opp.is_active,
            opp.raw_source_payload,
            opp.last_crawled,
            opp.opportunity_kind ?? null,
            opp.source_trust_tier ?? null,
            opp.reality_status ?? null,
            opp.reality_reasons ?? null,
          );
          inserted++;
        }
      } catch (error) {
        errors++;
        const errorMsg = `Error ingesting ${opp.source_id}: ${error.message}`;
        console.error(`[ingestion] ${errorMsg}`);
        errorMessages.push(errorMsg);
        
        // Stop if too many errors
        if (errors > 10) {
          throw new Error(`Too many errors during ingestion: ${errors}`);
        }
      }
    }
  });
  
  try {
    ingest();
    
    // Update ingestion run as completed
    const completeRun = db.prepare(`
      UPDATE ingestion_runs
      SET status = 'completed',
          completed_at = ?,
          records_inserted = ?,
          records_updated = ?
      WHERE id = ?
    `);
    
    completeRun.run(new Date().toISOString(), inserted, updated, runId);

    // Capture per-result evidence snippets for every persisted opportunity
    // (best-effort, outside the write transaction so it can never block or
    // roll back the ingest). The id resolves to the row stored above because
    // the upsert keys on (source, source_id).
    for (const opp of validated) {
      try {
        const existing = checkExists.get(opp.source, opp.source_id);
        const oppId = existing?.id ?? opp.id;
        if (oppId) {
          await persistEvidence(db, oppId, opp);
        }
      } catch {
        /* persistEvidence is best-effort; never block ingestion */
      }
    }

    log.info(`[ingestion] Completed run ${runId}: inserted=${inserted}, updated=${updated}, errors=${errors}`);
    
    return {
      success: true,
      run_id: runId,
      source: sourceName,
      records_fetched: opportunities.length,
      records_inserted: inserted,
      records_updated: updated,
      records_rejected_policy: policySkipped,
      records_rejected_reviewer: reviewerSkipped,
      records_rejected_reality: realitySkipped,
      errors,
      error_messages: errorMessages,
    };
  } catch (error) {
    // Rollback transaction if possible
    // better-sqlite3 rolls back automatically when the transaction function throws.
// No manual rollback call is needed or available.
    
    // Update ingestion run as failed
    const failRun = db.prepare(`
      UPDATE ingestion_runs
      SET status = 'failed',
          completed_at = ?,
          error_message = ?
      WHERE id = ?
    `);
    
    failRun.run(new Date().toISOString(), error.message, runId);
    
    console.error(`[ingestion] Failed run ${runId}:`, error.message);
    
    return {
      success: false,
      run_id: runId,
      source: sourceName,
      error: error.message,
      records_fetched: opportunities.length,
      records_inserted: inserted,
      records_updated: updated,
      errors,
      error_messages: errorMessages,
    };
  }
}

/**
 * Get ingestion status for all sources
 * @param {object} db - Database connection
 * @returns {object} Status by source
 */
export function getIngestionStatus(db) {
  // Derive the source list dynamically from what is actually in the DB
const sourceRows = db.prepare(
  `SELECT DISTINCT source FROM ingestion_runs ORDER BY source`
).all();
const sources = sourceRows.map(r => r.source);
  const status = {};
  
  for (const source of sources) {
    // Get last successful run
    const lastRun = db.prepare(`
      SELECT *
      FROM ingestion_runs
      WHERE source = ? AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get(source);
    
    // Get count of opportunities from this source
    const count = db.prepare(`
      SELECT COUNT(*) as count
      FROM funding_opportunities
      WHERE source = ? AND is_active = 1
    `).get(source);
    
    // Get last error if any
    const lastError = db.prepare(`
      SELECT error_message, completed_at
      FROM ingestion_runs
      WHERE source = ? AND status = 'failed'
      ORDER BY completed_at DESC
      LIMIT 1
    `).get(source);
    
    status[source] = {
      last_ingested_at: lastRun?.completed_at || null,
      count: count?.count || 0,
      last_error: lastError ? {
        message: lastError.error_message,
        occurred_at: lastError.completed_at,
      } : null,
    };
  }
  
  // Get total count
  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM funding_opportunities
    WHERE is_active = 1
  `).get();
  
  return {
    sources: status,
    total_opportunities: total?.count || 0,
  };
}

export default {
  ingestOpportunities,
  getIngestionStatus,
};
