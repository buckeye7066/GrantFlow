/**
 * Crawler Job Creation Utility
 * 
 * Centralized job creation with automatic idempotency, validation, and snapshot management.
 * All crawler job creation MUST use this module to ensure consistency.
 */

import crypto from 'crypto'
import { buildProfileContext } from './profileHelpers.js'
import { validateJobStatus, validateZipCode, validateStateCode, validateUuid } from '../utils/dbValidation.js'

// Postgres migrations run asynchronously at startup (see `backend/start.js`), so during deploys
// a new app instance may begin creating crawler jobs before the latest migrations add new columns.
// We cache a one-time schema probe so job creation can safely omit columns that don't exist yet.
let postgresHasProfileContextSnapshotColumnPromise = null

async function postgresHasProfileContextSnapshotColumn(db) {
  if (!db || db?.dialect !== 'postgres') return true
  if (postgresHasProfileContextSnapshotColumnPromise) {
    return await postgresHasProfileContextSnapshotColumnPromise
  }

  postgresHasProfileContextSnapshotColumnPromise = (async () => {
    try {
      const row = await db
        .prepare(
          `
            SELECT 1 AS ok
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'crawler_jobs'
              AND column_name = 'profile_context_snapshot'
            LIMIT 1
          `,
        )
        .get()
      return Boolean(row?.ok)
    } catch (error) {
      console.warn(
        '[createCrawlerJob] Unable to probe crawler_jobs.profile_context_snapshot; assuming missing to avoid 500s during migration catch-up.',
        error?.message || String(error),
      )
      return false
    }
  })()

  return await postgresHasProfileContextSnapshotColumnPromise
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

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

  const createdAtIso = new Date().toISOString()

  // Validate job type
  const VALID_TYPES = [
    'local',
    'scholarship',
    'health_resources',
    'comprehensive',
    'national',
    'item_search',
    'item_gift_search',
    'avatar_lookup',
    'document_ingest',
    'pipeline_automation',
    'profile_enrichment',
    'national_zip_scan',
  ]

  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid crawler job type: ${type}`)
  }

  // Validate and normalize status
  const normalizedStatus = validateJobStatus(status)

  // Generate idempotency key.
  //
  // IMPORTANT:
  // When callers explicitly skip idempotency (force-rerun), we must not reuse the same key,
  // otherwise the UNIQUE index on crawler_jobs.idempotency_key will throw and the job can't be created.
  const idempotencyKey = skipIdempotencyCheck ? null : generateIdempotencyKey(type, profileId, parameters)

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
    const context = await buildProfileContext(db, profileId, { asOf: createdAtIso })
    profileContextSnapshot = stableStringify(context)
  }

  // Create job ID
  const jobId = crypto.randomUUID()

  // Insert job (transactional)
  const parametersJson = JSON.stringify(parameters)

  if (db?.dialect === 'postgres') {
    const hasSnapshotCol = await postgresHasProfileContextSnapshotColumn(db)
    if (hasSnapshotCol) {
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          jobId,
          type,
          normalizedStatus,
          profileId,
          organizationId,
          parametersJson,
          profileContextSnapshot,
          idempotencyKey,
          requestedBy,
          createdAtIso,
        )
    } else {
      // NOTE: Omit profile_context_snapshot while migrations catch up.
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
              idempotency_key,
              requested_by,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          jobId,
          type,
          normalizedStatus,
          profileId,
          organizationId,
          parametersJson,
          idempotencyKey,
          requestedBy,
          createdAtIso,
        )
    }
  } else {
    // SQLite behavior unchanged.
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        jobId,
        type,
        normalizedStatus,
        profileId,
        organizationId,
        parametersJson,
        profileContextSnapshot,
        idempotencyKey,
        requestedBy,
        createdAtIso,
      )
  }

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
  const badRequest = (message) => {
    const err = new Error(message)
    err.statusCode = 400
    return err
  }

  switch (type) {
    case 'local':
      // zip/state are OPTIONAL.
      // If omitted, the local crawler derives state/zip from the linked profile/organization signals.
      if (validated.zip) {
        try {
          validated.zip = validateZipCode(validated.zip)
        } catch (error) {
          throw badRequest(error?.message || 'Invalid ZIP code')
        }
      }
      if (validated.state) {
        try {
          validated.state = validateStateCode(validated.state)
        } catch (error) {
          throw badRequest(error?.message || 'Invalid state code')
        }
      }
      break

    case 'scholarship':
      // Optional filters
      if (validated.gpa && (validated.gpa < 0 || validated.gpa > 4.0)) {
        throw badRequest('GPA must be between 0 and 4.0')
      }
      break

    case 'item_search':
      // Requires item description
      if (!validated.item) {
        throw badRequest('Item search requires item parameter')
      }
      break

    case 'item_gift_search':
      // Requires item description (what the user needs donated/gifted)
      if (!validated.item) {
        throw badRequest('Item gift search requires item parameter')
      }
      break

    case 'document_ingest':
      // Requires document ID
      if (!validated.documentId && !validated.document_id) {
        throw badRequest('Document ingest requires documentId parameter')
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
        throw badRequest('National zip scan requires zip parameter')
      }
      try {
        validated.zip = validateZipCode(validated.zip)
      } catch (error) {
        throw badRequest(error?.message || 'Invalid ZIP code')
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
  return validateJobStatus(status)
}
