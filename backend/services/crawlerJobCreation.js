/**
 * Crawler Job Creation Utility
 * 
 * Centralized job creation with automatic idempotency, validation, and snapshot management.
 * All crawler job creation MUST use this module to ensure consistency.
 */

import crypto from 'crypto'
import { buildProfileContext } from './profileHelpers.js'

/**
 * Generate idempotency key for a crawler job
 * @param {string} type - Job type
 * @param {string} profileId - Profile ID (optional)
 * @param {object} parameters - Job parameters
 * @returns {string} Idempotency key (32 chars)
 */
export function generateIdempotencyKey(type, profileId, parameters) {
  const normalizedParams = JSON.stringify(parameters || {})
  const input = `${type}:${profileId || 'null'}:${normalizedParams}`
  return crypto.createHash('sha256').update(input).digest('hex').substring(0, 32)
}

/**
 * Create a crawler job with idempotency, validation, and snapshot
 * 
 * @param {object} db - Database connection
 * @param {object} options - Job creation options
 * @param {string} options.type - Job type (required)
 * @param {string} [options.profileId] - Profile ID
 * @param {string} [options.organizationId] - Organization ID
 * @param {object} [options.parameters] - Job parameters
 * @param {string} [options.requestedBy] - User ID who requested the job
 * @param {string} [options.status='queued'] - Initial status
 * @param {boolean} [options.buildSnapshot=true] - Whether to build profile context snapshot
 * @param {boolean} [options.skipIdempotencyCheck=false] - Skip idempotency check (dangerous!)
 * @returns {Promise<object>} Created or existing job { jobId, created, existing }
 */
export async function createCrawlerJob(db, options) {
  const {
    type,
    profileId = null,
    organizationId = null,
    parameters = {},
    requestedBy = null,
    status = 'queued',
    buildSnapshot = true,
    skipIdempotencyCheck = false,
  } = options

  // Validate job type
  const VALID_TYPES = [
    'local',
    'scholarship',
    'comprehensive',
    'national',
    'item_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
  ]

  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid crawler job type: ${type}`)
  }

  // Generate idempotency key
  const idempotencyKey = generateIdempotencyKey(type, profileId, parameters)

  // Check for existing job with same idempotency key (unless explicitly skipped)
  if (!skipIdempotencyCheck) {
    const existing = await db
      .prepare('SELECT * FROM crawler_jobs WHERE idempotency_key = ? AND status IN (?, ?)')
      .get(idempotencyKey, 'queued', 'running')

    if (existing) {
      console.log('[createCrawlerJob] Found existing job with same idempotency key', {
        jobId: existing.id,
        type,
        status: existing.status,
      })
      return {
        jobId: existing.id,
        created: false,
        existing: true,
        job: existing,
      }
    }
  }

  // Build profile context snapshot if requested and profileId provided
  let profileContextSnapshot = null
  if (buildSnapshot && profileId) {
    try {
      const context = await buildProfileContext(db, profileId)
      profileContextSnapshot = JSON.stringify(context)
    } catch (error) {
      console.warn('[createCrawlerJob] Failed to build profile context snapshot:', error?.message)
      // Continue without snapshot - dispatcher will handle this
    }
  }

  // Create job ID
  const jobId = crypto.randomUUID()

  // Insert job (transactional)
  const parametersJson = JSON.stringify(parameters)
  
  await db
    .prepare(
      `
      INSERT INTO crawler_jobs (
        id,
        type,
        status,
        profile_id,
        organization_id,
        parameters,
        profile_context_snapshot,
        idempotency_key,
        requested_by,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `,
    )
    .run(
      jobId,
      type,
      status,
      profileId,
      organizationId,
      parametersJson,
      profileContextSnapshot,
      idempotencyKey,
      requestedBy,
    )

  console.log('[createCrawlerJob] Created new crawler job', {
    jobId,
    type,
    profileId,
    hasSnapshot: !!profileContextSnapshot,
    idempotencyKey,
  })

  return {
    jobId,
    created: true,
    existing: false,
    job: { id: jobId, type, status, profile_id: profileId, idempotency_key: idempotencyKey },
  }
}

/**
 * Create multiple crawler jobs in a transaction
 * @param {object} db - Database connection
 * @param {Array<object>} jobs - Array of job options (same as createCrawlerJob)
 * @returns {Promise<Array<object>>} Array of results { jobId, created, existing }
 */
export async function createCrawlerJobs(db, jobs) {
  const results = []
  
  // Create all jobs in sequence (for transaction safety with SQLite)
  for (const jobOptions of jobs) {
    const result = await createCrawlerJob(db, jobOptions)
    results.push(result)
  }
  
  return results
}

/**
 * Validate crawler job parameters based on type
 * @param {string} type - Job type
 * @param {object} parameters - Job parameters
 * @returns {object} Validated and normalized parameters
 * @throws {Error} If validation fails
 */
export function validateJobParameters(type, parameters = {}) {
  const validated = { ...parameters }

  switch (type) {
    case 'local':
      // Requires zip or state
      if (!validated.zip && !validated.state) {
        throw new Error('Local crawler requires zip or state parameter')
      }
      if (validated.zip && !/^\d{5}$/.test(validated.zip)) {
        throw new Error('Invalid zip code format (must be 5 digits)')
      }
      if (validated.state && !/^[A-Z]{2}$/.test(validated.state?.toUpperCase())) {
        throw new Error('Invalid state code (must be 2 letters)')
      }
      // Normalize state to uppercase
      if (validated.state) {
        validated.state = validated.state.toUpperCase()
      }
      break

    case 'scholarship':
      // Optional filters
      if (validated.gpa && (validated.gpa < 0 || validated.gpa > 4.0)) {
        throw new Error('GPA must be between 0 and 4.0')
      }
      break

    case 'item_search':
      // Requires item description
      if (!validated.item) {
        throw new Error('Item search requires item parameter')
      }
      break

    case 'document_ingest':
      // Requires document ID
      if (!validated.documentId && !validated.document_id) {
        throw new Error('Document ingest requires documentId parameter')
      }
      // Normalize to documentId
      if (validated.document_id && !validated.documentId) {
        validated.documentId = validated.document_id
        delete validated.document_id
      }
      break

    case 'national':
      // Optional profile context
      break

    case 'comprehensive':
      // No required parameters
      break

    case 'avatar_lookup':
      // No required parameters
      break

    case 'profile_enrichment':
      // No required parameters
      break

    case 'pipeline_automation':
      // No required parameters
      break

    case 'national_zip_scan':
      // Requires zip
      if (!validated.zip) {
        throw new Error('National zip scan requires zip parameter')
      }
      if (!/^\d{5}$/.test(validated.zip)) {
        throw new Error('Invalid zip code format (must be 5 digits)')
      }
      break

    default:
      // Unknown type - allow any parameters
      break
  }

  return validated
}

/**
 * Normalize job status value
 * @param {string} status - Status value
 * @returns {string} Normalized status
 * @throws {Error} If status is invalid
 */
export function normalizeJobStatus(status) {
  const VALID_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled']
  const normalized = String(status || 'queued').toLowerCase()
  
  if (!VALID_STATUSES.includes(normalized)) {
    throw new Error(`Invalid job status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  
  return normalized
}
