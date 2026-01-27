import express from 'express'
import crypto from 'crypto'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import multer from 'multer'
import fs from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { buildProfileSectionPrompt, supportedSectionKeys } from '../prompts/profileSections.js'
import { PROFILE_SCHEMA, getDefaultSectionData } from '../config/profileSchema.js'
import { dispatchCrawlerJob } from '../services/crawlerDispatcher.js'
import { ensureBillingAccount, mapAccountRow } from '../services/billingAccounts.js'
import { extractCompletionText } from '../utils/openai.js'
import { linkProfileToAdmin } from '../utils/adminProfileLinks.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { validatePagination } from '../utils/validation.js'
import { formatError } from '../middleware/errorHandler.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import {
  listProfileEmails,
  addProfileEmails,
  removeProfileEmail,
  isAdminUserWithDb,
  getAuthUserId,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'

const router = express.Router()

function isAuthenticatedFromCtx(ctx) {
  return Boolean(ctx && (ctx.userId || ctx.activeProfileId || ctx.email))
}

function denyAuth(req, res) {
  const authenticated = isAuthenticatedFromCtx(req.ctx)
  return res.status(authenticated ? 403 : 401).json({
    error: authenticated ? 'Not authorized' : 'Authentication required',
  })
}

function canAccessProfileIdFromCtx(ctx, profileId) {
  const id = String(profileId)
  if (ctx?.isAdmin === true) return true
  if (ctx?.accessibleProfileIds === null) return true // admin sentinel (all)
  if (ctx?.activeProfileId && String(ctx.activeProfileId) === id) return true
  if (ctx?.accessibleProfileIds instanceof Set && ctx.accessibleProfileIds.has(id)) return true
  return false
}

function canAccessProfileRowFromCtx(ctx, profileRow) {
  if (!profileRow) return false
  if (canAccessProfileIdFromCtx(ctx, profileRow.id)) return true
  if (ctx?.userId && profileRow.user_id && String(ctx.userId) === String(profileRow.user_id)) return true
  return false
}

// Central enforcement: any route that includes a `:id` param in this router refers to a profile id.
// This prevents profile “bleed” from stale token claims; access is always re-validated.
router.param('id', async (req, res, next, id) => {
  try {
    // Fast path: prefer the canonical requestContext computation.
    // This avoids recomputing access sets (and avoids 403s when DB checks are transiently failing).
    if (canAccessProfileIdFromCtx(req.ctx, id)) return next()

    // If unauthenticated, this is a clean 401 (never 500).
    if (!isAuthenticatedFromCtx(req.ctx)) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    // As a last resort, verify ownership by userId (covers cases where access sets are empty/unavailable).
    if (req.ctx?.userId) {
      const row = await req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(String(id))
      if (row?.user_id && String(row.user_id) === String(req.ctx.userId)) return next()
    }

    return res.status(403).json({ error: 'Not authorized to access this profile' })
  } catch (error) {
    console.warn('[profiles] access precheck failed; denying access', {
      profileId: String(id),
      error: error?.message || String(error),
    })
    return denyAuth(req, res)
  }
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const uploadDir = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, '..', 'uploads')

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
    const extension = file.originalname.split('.').pop()
    cb(null, `${unique}.${extension}`)
  },
})

const imageFileFilter = (_req, file, cb) => {
  const mime = String(file?.mimetype || '')
  if (mime.startsWith('image/')) {
    return cb(null, true)
  }

  // Some clients may omit mimetype; fall back to extension check.
  const name = String(file?.originalname || '').toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop() : ''
  const allowedExt = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif'])
  if (allowedExt.has(ext)) {
    return cb(null, true)
  }

  return cb(new Error('Only image uploads are allowed'))
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  // Phone photos are often >5MB; keep this reasonable while still preventing abuse.
  limits: { fileSize: 15 * 1024 * 1024 },
})

function runUploadSingle(fieldName) {
  const middleware = upload.single(fieldName)
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next()
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Image is too large. Max size is 15MB.' })
        }
      }
      return res.status(400).json({ error: err?.message || 'Upload failed' })
    })
  }
}

const profileSelect = `
  SELECT 
    p.id,
    p.created_at,
    p.updated_at,
    p.created_by,
    p.organization_id,
    p.user_id,
    p.primary_type,
    COALESCE(NULLIF(TRIM(p.display_name), ''), o.name) AS display_name,
    p.status,
    p.tags,
    p.avatar_url,
    o.name AS organization_name
  FROM profiles p
  LEFT JOIN organizations o ON o.id = p.organization_id
`

function mapProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    organization_id: row.organization_id,
    organization_name: row.organization_name ?? null,
    user_id: row.user_id ?? null,
    primary_type: row.primary_type,
    display_name: row.display_name,
    // Backwards-compatible aliases for older UI components that expect "organization-like" fields.
    name: row.display_name,
    applicant_type: row.primary_type,
    status: row.status,
    tags: safeParseJSON(row.tags, []),
    avatar_url: row.avatar_url ?? null,
    profile_image_url: row.avatar_url ?? null,
  }
}

async function enrichProfileWithSummary(db, profile) {
  // Get billing account info
  const billingAccount = await ensureBillingAccount(db, profile.id)
  profile.billing = mapAccountRow(billingAccount)
  
  // Get section completion stats
  const sections = await db
    .prepare('SELECT COUNT(*) as total FROM profile_sections WHERE profile_id = ?')
    .get(profile.id)
  profile.sections_complete = sections?.total ?? 0
  
  // Get pipeline funds total
  const pipelineFunds = await db
    .prepare(`
      SELECT COALESCE(SUM(g.amount_requested), 0) as total
      FROM grants g
      WHERE g.organization_id = ?
      AND g.status IN ('interested', 'drafting', 'app_prep', 'revision', 'submitted', 'under_review')
    `)
    .get(profile.organization_id)
  profile.pipeline_funds_total = pipelineFunds?.total ?? 0
  
  // Get document count
  const docs = await db
    .prepare('SELECT COUNT(*) as total FROM profile_documents WHERE profile_id = ?')
    .get(profile.id)
  profile.document_count = docs?.total ?? 0
  
  return profile
}

function getOpenAI() {
  return createOpenAIClient().openai
}

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
      maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
    })
  } catch (error) {
    // Production hardening: if the Anthropic SDK isn't installed (or fails to load),
    // do not 500 the endpoint — fall back to the configured provider(s) or a clear 503.
    console.warn('[profiles/ai] Anthropic client unavailable:', error?.message || String(error))
    return null
  }
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part === 'string') return part
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

router.get('/', async (req, res) => {
  // Canonical truth is req.ctx, but harden against any transient ctx-building issues
  // by falling back to a DB-backed admin check (never token-only).
  const user = req.user ?? { role: 'guest' }
  const isAdmin =
    req.ctx?.isAdmin === true ? true : await isAdminUserWithDb(req.db, user)
  const includeSummary = req.query.summary === 'true'
  const includeDeleted = req.query.includeDeleted === 'true'
  const userId = req.ctx?.userId ?? getAuthUserId(user) ?? null
  
  // Validate pagination parameters.
  // For admins, default to the max page size unless a limit is explicitly provided.
  // This prevents "missing profiles" in the UI when admins expect to see everything.
  const paginationQuery = { ...req.query }
  const limitProvided = Object.prototype.hasOwnProperty.call(req.query ?? {}, 'limit')
  if (isAdmin && !limitProvided) {
    paginationQuery.limit = 1000
    paginationQuery.offset = 0
  }
  const { limit, offset } = validatePagination(paginationQuery);

  // Check if user is admin
  if (!isAdmin) {
    // Enduser: return all profiles the user can access.
    // This includes ownership (profiles.user_id) AND shared access via profile_emails.
    if (!userId) return res.status(401).json({ error: 'Authentication required' })

    // Prefer the canonical access set computed by requestContext.
    // If it's missing for some reason, recompute it (still DB-backed and safe).
    let accessibleProfileIds = req.ctx?.accessibleProfileIds
    if (accessibleProfileIds == null) {
      try {
        accessibleProfileIds = await getAccessibleProfileIds(req.db, user)
      } catch {
        accessibleProfileIds = new Set()
      }
    }

    const ids =
      accessibleProfileIds instanceof Set ? Array.from(accessibleProfileIds) : []

    if (ids.length === 0) {
      return res.json([])
    }

    const placeholders = ids.map(() => '?').join(', ')
    const whereDeleted = includeDeleted ? '' : " AND (p.status IS NULL OR p.status <> 'deleted')"

    // Get all accessible profiles (with pagination)
    const rows = await req.db
      .prepare(
        `${profileSelect} WHERE p.id IN (${placeholders})${whereDeleted} ORDER BY p.created_at ASC LIMIT ? OFFSET ?`,
      )
      .all(...ids, limit, offset)
    
    const profiles = rows.map(mapProfile)
    if (includeSummary) {
      for (const profile of profiles) {
        await enrichProfileWithSummary(req.db, profile)
      }
    }
    return res.json(profiles)
  }

  // Admin: return ALL profiles with pagination
  const adminWhere = includeDeleted ? '' : "WHERE (p.status IS NULL OR p.status <> 'deleted')"
  const stmt = req.db.prepare(`${profileSelect} ${adminWhere} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`)
  const profiles = (await stmt.all(limit, offset)).map(mapProfile)
  
  if (includeSummary) {
    for (const profile of profiles) {
      await enrichProfileWithSummary(req.db, profile)
    }
  }
  
  res.json(profiles)
})

// Canonical profile schema (data points + explanations)
// IMPORTANT: This must be defined before `/:id` routes to avoid being captured as a profile id.
router.get('/schema', async (_req, res) => {
  res.json({
    version: '1.0',
    generated_at: new Date().toISOString(),
    sections: PROFILE_SCHEMA,
    supported_section_keys: supportedSectionKeys,
  })
})

function normalizeEmail(email = '') {
  const v = String(email || '').trim().toLowerCase()
  return v || null
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

// Profile login allowlist (board members, collaborators).
router.get('/:id/emails', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    const profileRow = await req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId)
    const canManage =
      req.ctx?.isAdmin === true ||
      (req.ctx?.userId && profileRow?.user_id && String(profileRow.user_id) === String(req.ctx.userId)) ||
      (req.ctx?.activeProfileId && String(req.ctx.activeProfileId) === profileId)
    if (!canManage) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    const emails = await listProfileEmails(req.db, profileId)
    res.json({ emails })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/:id/emails', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    const profileRow = await req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId)
    const canManage =
      req.ctx?.isAdmin === true ||
      (req.ctx?.userId && profileRow?.user_id && String(profileRow.user_id) === String(req.ctx.userId)) ||
      (req.ctx?.activeProfileId && String(req.ctx.activeProfileId) === profileId)
    if (!canManage) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    const raw = req.body?.emails ?? req.body?.email
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    const normalized = list.map((e) => normalizeEmail(e)).filter(Boolean)
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'emails is required' })
    }
    if (normalized.length > 25) {
      return res.status(400).json({ error: 'Too many emails (max 25)' })
    }
    const invalid = normalized.filter((e) => !isValidEmail(e))
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid email(s): ${invalid.slice(0, 3).join(', ')}` })
    }

    const addedBy = req.ctx?.userId ?? req.ctx?.email ?? null
    await addProfileEmails(req.db, { profileId, emails: normalized, addedBy })
    const emails = await listProfileEmails(req.db, profileId)
    res.status(201).json({ emails })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.delete('/:id/emails/:emailId', async (req, res) => {
  try {
    if (!isAuthenticatedFromCtx(req.ctx)) return res.status(401).json({ error: 'Authentication required' })
    const profileId = String(req.params.id)

    const profileRow = await req.db.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId)
    const canManage =
      req.ctx?.isAdmin === true ||
      (req.ctx?.userId && profileRow?.user_id && String(profileRow.user_id) === String(req.ctx.userId)) ||
      (req.ctx?.activeProfileId && String(req.ctx.activeProfileId) === profileId)
    if (!canManage) {
      return res.status(403).json({ error: 'Not authorized to manage profile emails' })
    }

    const emailId = String(req.params.emailId)
    const result = await removeProfileEmail(req.db, { profileId, emailId })
    res.json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

router.post('/', async (req, res) => {
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null
  const { display_name, primary_type, organization_id, user_id, created_by, status = 'active', tags = [] } = req.body ?? {}

  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name is required' })
  }

  // Check permissions
  if (!isAdmin) {
    // Enduser can only create profiles for themselves
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    
    if (user_id && user_id !== userId) {
      return res.status(403).json({ 
        error: 'Endusers can only create profiles for themselves' 
      })
    }
  } else {
    // Admin can create for anyone
    if (user_id && !(await req.db.prepare('SELECT id FROM users WHERE id = ?').get(user_id))) {
      return res.status(400).json({ error: 'Invalid user_id: user does not exist' })
    }
  }

  // Validate organization_id if provided
  if (organization_id) {
    const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
    if (!org) {
      return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
    }
  }

  // Determine user_id for the new profile
  const profileUserId = isAdmin ? (user_id || userId) : userId

  const profileId = crypto.randomUUID()
  // Ensure every newly created profile starts with all canonical sections + canonical keys.
  // This prevents downstream crawlers/scoring from encountering missing sections.
  await req.db.withTransaction(async (tx) => {
    const insert = tx.prepare(`
      INSERT INTO profiles (id, display_name, primary_type, organization_id, user_id, created_by, status, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    await insert.run(
      profileId,
      display_name,
      primary_type ?? null,
      organization_id ?? null,
      profileUserId ?? null,
      created_by ?? req.ctx?.userId ?? req.ctx?.email ?? null,
      status,
      JSON.stringify(tags),
    )

    const upsertSection = tx.prepare(
      `
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, section_key) DO NOTHING
      `,
    )

    for (const sectionKey of supportedSectionKeys) {
      const defaults = getDefaultSectionData(sectionKey)
      await upsertSection.run(profileId, sectionKey, JSON.stringify(defaults ?? {}), 'system-create')
    }
  })

  await linkProfileToAdmin(req.db, profileId)
  const refreshed = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(profileId)
  res.status(201).json(mapProfile(refreshed))
})

router.get('/:id', async (req, res) => {
  const { id } = req.params
  const isAdmin = req.ctx?.isAdmin === true
  const userId = req.ctx?.userId ?? null

  let row = null
  try {
    row = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  } catch (error) {
    console.error('[profiles] Failed to load profile row:', error)
    return res.status(500).json(formatError(error))
  }

  if (!row) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  // Check access permissions
  if (!isAdmin) {
    // Enduser: can only access profiles where user_id matches
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    if (!canAccessProfileRowFromCtx(req.ctx, row)) {
      return res.status(403).json({ error: 'Access denied' })
    }
  }

  let sections = []
  try {
    sections = (await req.db
      .prepare(
        `
        SELECT section_key, data, updated_at, updated_by
        FROM profile_sections
        WHERE profile_id = ?
        ORDER BY section_key
      `,
      )
      .all(id)).map((section) => ({
      section_key: section.section_key,
      data: safeParseJSON(section.data, {}),
      updated_at: section.updated_at,
      updated_by: section.updated_by,
    }))
  } catch (error) {
    // Never 500 just because sections are missing/migrating.
    console.warn('[profiles] Unable to load profile sections:', id, error?.message || error)
    sections = []
  }

  let billing = null
  try {
    billing = mapAccountRow(await ensureBillingAccount(req.db, id))
  } catch (error) {
    console.warn('[profiles] Unable to load billing account for profile', id, error?.message || error)
    billing = null
  }

  return res.json({
    ...mapProfile(row),
    sections,
    billing,
  })
})

router.put('/:id', async (req, res) => {
  const { id } = req.params
  const { display_name, primary_type, organization_id, status, tags } = req.body ?? {}
  const isAdmin = req.ctx?.isAdmin === true
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  // Allow: admins (including admin-email allowlist), profile-scoped tokens for the profile, or session owners (userId match)
  const userIsAdmin = Boolean(isAdmin)
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id
  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  const updates = []
  const values = []

  if (display_name !== undefined) {
    if (typeof display_name !== 'string' || display_name.trim() === '') {
      return res.status(400).json({ error: 'display_name must be a non-empty string' })
    }
    updates.push('display_name = ?')
    values.push(display_name)
  }

  if (primary_type !== undefined) {
    updates.push('primary_type = ?')
    values.push(primary_type || null)
  }

  if (organization_id !== undefined) {
    // Validate organization_id if provided and not null
    if (organization_id) {
      const org = await req.db.prepare('SELECT id FROM organizations WHERE id = ?').get(organization_id)
      if (!org) {
        return res.status(400).json({ error: 'Invalid organization_id: organization does not exist' })
      }
    }
    updates.push('organization_id = ?')
    values.push(organization_id || null)
  }

  if (status !== undefined) {
    updates.push('status = ?')
    values.push(status)
  }

  if (tags !== undefined) {
    updates.push('tags = ?')
    values.push(JSON.stringify(tags ?? []))
  }

  if (updates.length === 0) {
    return res.json(mapProfile(existing))
  }

  const stmt = req.db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`)
  await stmt.run(...values, id)

  const updated = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  res.json(mapProfile(updated))
})

router.delete('/:id', async (req, res) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  // Check authorization - user must be admin or the profile must belong to them
  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const admin = req.ctx?.isAdmin === true
  if (!admin) {
    const matchesProfileId = authProfileId === String(id)
    const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id
    if (!matchesProfileId && !matchesUserId) {
      return denyAuth(req, res)
    }
  }

  // Designated/demo profiles are intentionally "ensured" by boot-time seeding.
  // If we hard-delete them, the seeder will re-create them on the next run.
  // So for these IDs, always use a durable tombstone (soft-delete).
  if (isDesignatedProfileId(id)) {
    await req.db
      .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id)
    console.info('[profiles] Soft-deleted designated profile (tombstoned):', String(id))
    return res.status(204).send()
  }

  // Delete the profile.
  //
  // IMPORTANT (Postgres):
  // Hard DELETE can fail due to FK RESTRICT constraints, and setting profile_id = NULL during cleanup
  // can also fail when those columns are NOT NULL. To avoid 500s, fall back to a reliable soft-delete.
  try {
    const stmt = req.db.prepare('DELETE FROM profiles WHERE id = ?')
    await stmt.run(id)
  } catch (error) {
    console.warn('[profiles] Hard DELETE failed; soft-deleting profile:', id, error?.message || error)

    // Best-effort cleanup of rows owned by the profile. Do NOT attempt `SET profile_id = NULL`.
    try {
      await req.db.transaction(async (tx) => {
        try {
          await tx.prepare('DELETE FROM profile_documents WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM profile_sections WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM crawler_jobs WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM crawler_schedules WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_tool_usage WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_tasks WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM anya_sessions WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM service_applications WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx.prepare('DELETE FROM funding_opportunities WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }
        try {
          await tx
            .prepare(
              `
                DELETE FROM billing_account_events
                WHERE account_id IN (SELECT id FROM billing_accounts WHERE profile_id = ?)
              `,
            )
            .run(id)
          await tx.prepare('DELETE FROM billing_accounts WHERE profile_id = ?').run(id)
        } catch {
          // ignore best-effort cleanup errors
        }

        await tx
          .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(id)
      })
    } catch (softDeleteError) {
      // If the transaction fails (schema drift, missing tables, etc.), still attempt a direct soft delete.
      console.warn('[profiles] Soft-delete transaction failed; attempting direct soft-delete:', id, softDeleteError?.message || softDeleteError)
      await req.db
        .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(id)
    }
  }

  // Clean up avatar file if it exists
  if (existing.avatar_url && existing.avatar_url.startsWith('/uploads/')) {
    const filename = existing.avatar_url.replace('/uploads/', '')
    if (filename) {
      const avatarPath = join(uploadDir, filename)
      fs.unlink(avatarPath, (err) => {
        if (err) console.warn('Failed to delete avatar file:', err)
      })
    }
  }

  res.status(204).send()
})

router.post('/:id/avatar', runUploadSingle('avatar'), async (req, res, next) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const existing = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!existing) {
    if (req.file) fs.unlink(join(uploadDir, req.file.filename), () => {})
    return res.status(404).json({ error: 'Profile not found' })
  }

  const userIsAdmin = req.ctx?.isAdmin === true
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && existing.user_id && authUserId === existing.user_id

  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    if (req.file) fs.unlink(join(uploadDir, req.file.filename), () => {})
    return denyAuth(req, res)
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Avatar file is required' })
  }

  try {
    const publicPath = `/uploads/${req.file.filename}`
    await req.db
      .prepare('UPDATE profiles SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(publicPath, id)

    const previousAvatar = existing.avatar_url
    if (previousAvatar && previousAvatar.startsWith('/uploads/')) {
      const previousFilename = previousAvatar.replace('/uploads/', '')
      if (previousFilename && previousFilename !== req.file.filename) {
        const previousPath = join(uploadDir, previousFilename)
        fs.unlink(previousPath, () => {})
      }
    }

    const updated = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    res.json(mapProfile(updated))
  } catch (error) {
    if (req.file) fs.unlink(join(uploadDir, req.file.filename), () => {})
    next(error)
  }
})

router.post('/:id/avatar/ai', async (req, res) => {
  const { id } = req.params
  const authUserId = req.ctx?.userId ?? null
  const authProfileId = req.ctx?.activeProfileId ? String(req.ctx.activeProfileId) : null

  const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profileRow) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  const userIsAdmin = req.ctx?.isAdmin === true
  const matchesProfileId = authProfileId === String(id)
  const matchesUserId = authUserId && profileRow.user_id && authUserId === profileRow.user_id
  if (!userIsAdmin && !matchesProfileId && !matchesUserId) {
    return denyAuth(req, res)
  }

  if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return

  const parameters = {
    display_name: profileRow.display_name,
    primary_type: profileRow.primary_type,
  }

  const jobId = crypto.randomUUID()
  const stmt = req.db.prepare(`
    INSERT INTO crawler_jobs (
      id,
      type,
      status,
      profile_id,
      organization_id,
      parameters,
      requested_by
    ) VALUES (?, 'avatar_lookup', 'queued', ?, ?, ?, ?)
  `)

  await stmt.run(
    jobId,
    profileRow.id,
    profileRow.organization_id ?? null,
    JSON.stringify(parameters),
    req.ctx?.isAdmin ? 'admin' : profileRow.id,
  )

  const job = await req.db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(jobId)

  dispatchCrawlerJob({
    db: req.db,
    jobId: job.id,
    uploadDir,
    getOpenAI,
  })

  res.status(202).json({
    id: job.id,
    status: job.status,
    type: job.type,
    created_at: job.created_at,
  })
})

router.get('/:id/sections', async (req, res) => {
  const { id } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const sections = (await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ?
      ORDER BY section_key
    `,
    )
    .all(id))
    .map((section) => ({
      section_key: section.section_key,
      data: safeParseJSON(section.data, {}),
      updated_at: section.updated_at,
      updated_by: section.updated_by,
    }))

  res.json(sections)
})

router.get('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const section = await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  if (!section) {
    return res.status(404).json({ error: 'Section not found' })
  }

  res.json({
    section_key: section.section_key,
    data: safeParseJSON(section.data, {}),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

router.put('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params
  const { data, updated_by } = req.body ?? {}

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  if (typeof data !== 'object' || data === null) {
    return res.status(400).json({ error: 'data payload must be an object' })
  }

  const upsert = req.db.prepare(
    `
    INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, section_key) DO UPDATE SET
      data = excluded.data,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `,
  )

  await upsert.run(id, sectionKey, JSON.stringify(data), updated_by ?? null)

  const section = await req.db
    .prepare(
      `
      SELECT section_key, data, updated_at, updated_by
      FROM profile_sections
      WHERE profile_id = ? AND section_key = ?
    `,
    )
    .get(id, sectionKey)

  res.json({
    section_key: section.section_key,
    data: safeParseJSON(section.data, {}),
    updated_at: section.updated_at,
    updated_by: section.updated_by,
  })
})

router.delete('/:id/sections/:sectionKey', async (req, res) => {
  const { id, sectionKey } = req.params

  const profile = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' })
  }

  if (!canAccessProfileRowFromCtx(req.ctx, profile)) {
    return denyAuth(req, res)
  }

  const stmt = req.db.prepare(`DELETE FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
  const result = await stmt.run(id, sectionKey)
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Section not found' })
  }
  res.status(204).send()
})

async function handleProfileSectionAi(req, res) {
  const { id, sectionKey } = req.params

  try {
    if (!supportedSectionKeys.includes(sectionKey)) {
      return res.status(400).json({ error: `Section "${sectionKey}" is not yet AI-enabled.` })
    }

    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profileRow)) {
      return denyAuth(req, res)
    }

    if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return

    const sectionRows = await req.db
      .prepare(
        `
        SELECT section_key, data
        FROM profile_sections
        WHERE profile_id = ?
      `,
      )
      .all(id)

    const sections = Object.fromEntries(
      sectionRows.map((row) => [row.section_key, safeParseJSON(row.data, {})]),
    )

    const docs = req.db
      .prepare(
        `
        SELECT d.id, d.name, d.type, d.status, d.notes
        FROM documents d
        JOIN profile_documents pd ON pd.document_id = d.id
        WHERE pd.profile_id = ?
        ORDER BY d.created_at DESC
      `,
      )
      .all(id)

    const promptPayload = buildProfileSectionPrompt(sectionKey, {
      profile: mapProfile(profileRow),
      sections,
      documents: docs,
    })

    if (!promptPayload) {
      return res.status(400).json({ error: `No prompt mapping for section "${sectionKey}"` })
    }

    const openai = getOpenAIOptional()

    // Provider order: OpenAI -> Anthropic -> deterministic empty fallback (never hard-fail the UI).
    if (openai) {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: promptPayload.prompt }],
        temperature: 0.2,
        max_tokens: 1200,
      })

      const raw = extractCompletionText(completion)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      const suggestion = safeParseJSON(jsonMatch ? jsonMatch[0] : raw, null)

      if (!suggestion || typeof suggestion !== 'object') {
        return res.status(502).json({
          error: 'AI response could not be parsed',
          raw_response: raw,
        })
      }

      return res.json({
        section_key: sectionKey,
        suggestion,
        usage: completion.usage ?? null,
        raw_response: raw,
        ai_provider: 'openai',
      })
    }

    const anthropic = await createAnthropicClient()
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
          max_tokens: 1200,
          temperature: 0.2,
          messages: [{ role: 'user', content: promptPayload.prompt }],
        })

        const raw = extractAnthropicText(response)
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        const suggestion = safeParseJSON(jsonMatch ? jsonMatch[0] : raw, null)

        if (!suggestion || typeof suggestion !== 'object') {
          return res.status(502).json({
            error: 'AI response could not be parsed',
            raw_response: raw,
          })
        }

        return res.json({
          section_key: sectionKey,
          suggestion,
          usage: null,
          raw_response: raw,
          ai_provider: 'anthropic',
        })
      } catch (anthropicError) {
        console.warn('[profiles/sections/ai] Anthropic failed:', anthropicError?.message || anthropicError)
      }
    }

    return res.status(503).json({
      error: 'ai_unavailable',
      message: 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider failed to initialize.',
      section_key: sectionKey,
    })
  } catch (error) {
    console.error('Error generating profile section suggestion:', error)
    res.status(500).json(formatError(error))
  }
}

// Back-compat for older clients:
// GET /api/profiles/:id/:sectionKey/ai (legacy) -> same as the canonical POST route.
router.get('/:id/:sectionKey/ai', handleProfileSectionAi)
router.post('/:id/sections/:sectionKey/ai', handleProfileSectionAi)

// Generate AI suggestion for individual profile field
router.post('/:id/fields/ai', async (req, res) => {
  const { id } = req.params
  const { fieldName, fieldLabel, currentValue, fieldDescription, sectionKey } = req.body

  try {
    // Get profile for context
    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (!canAccessProfileRowFromCtx(req.ctx, profileRow)) {
      return denyAuth(req, res)
    }

    if (!(await requireTierCapability(req, res, id, TIER_CAPABILITIES.DOCUMENT_AI))) return
    const profile = mapProfile(profileRow)

    // Pull real stored context from profile_sections so suggestions are actually grounded in this profile.
    const sectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)

    const sectionMap = new Map(
      sectionRows.map((row) => [String(row.section_key), safeParseJSON(row.data, {})]),
    )

    const preferredSectionOrder = [
      sectionKey,
      'basic_information',
      'organization_overview',
      'mission_statement',
      'programs',
      'services',
      'operations',
      'financials',
      'outcomes',
      'community_impact',
    ].filter(Boolean)

    const seen = new Set()
    const selectedSections = {}
    for (const key of preferredSectionOrder) {
      if (seen.has(key)) continue
      seen.add(key)
      const data = sectionMap.get(key)
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        selectedSections[key] = data
      }
    }

    const profileContextJson = JSON.stringify(
      {
        profile: {
          id: profile.id,
          name: profile.display_name,
          type: profile.primary_type,
          organization: profile.organization_name ?? null,
        },
        sections: selectedSections,
      },
      null,
      2,
    )
    const profileContext =
      profileContextJson.length > 2500 ? `${profileContextJson.slice(0, 2499)}…` : profileContextJson

    // Create focused prompt for the specific field
    const prompt = `You are assisting with filling out a grant application field.

Field Name: ${fieldLabel}
${fieldDescription ? `Field Description: ${fieldDescription}` : ''}
Current Value: ${currentValue || '(empty)'}
Section: ${sectionKey || 'general'}

PROFILE CONTEXT (from the saved profile; use this and do not invent facts):
${profileContext}

Please provide appropriate content for the "${fieldLabel}" field.
Requirements:
- Be specific and professional
- Use language suitable for grant applications
- For text fields: Provide 2-3 clear, concise sentences
- For numbers: Provide only the numeric value
- For descriptions: Be detailed but concise

Return ONLY the field value content, no JSON wrapper or explanations.`

    const openai = getOpenAIOptional()
    let suggestion
    
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 400,
        })
        suggestion = extractCompletionText(completion).trim()
        return res.json({
          field: fieldName,
          suggestion,
          usage: null,
          ai_provider: 'openai',
        })
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        console.warn('[Field AI] OpenAI request failed:', summary?.message || error?.message || error)
        // fall through to Anthropic / fallback (do not hard-fail the UI)
      }
    }

    const anthropic = await createAnthropicClient()
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
          max_tokens: 400,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        })
        suggestion = extractAnthropicText(response).trim()
        return res.json({
          field: fieldName,
          suggestion,
          usage: null,
          ai_provider: 'anthropic',
        })
      } catch (anthropicError) {
        console.warn('[Field AI] Anthropic request failed:', anthropicError?.message || anthropicError)
      }
    }
    
    res.json({
      field: fieldName,
      suggestion: typeof currentValue === 'string' ? currentValue : '',
      usage: null,
      ai_provider: 'fallback',
      warning: 'No AI provider configured (OPENAI_API_KEY/ANTHROPIC_API_KEY missing) or provider error.',
    })
  } catch (error) {
    console.error('Field AI suggestion error:', error)
    res.status(500).json({ error: error.message || 'Failed to generate AI suggestion for field' })
  }
})

// Profile completeness check
// GET /api/profiles/:id/completeness
router.get('/:id/completeness', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profile = await req.db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get existing sections for this profile
    const existingSectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)
    
    const existingSectionMap = new Map(
      existingSectionRows.map(s => [s.section_key, safeParseJSON(s.data, {})])
    )

    // Check against canonical sections + canonical keys (data points)
    const missingSections = []
    const emptySections = []
    const completedSections = []
    const missingKeysBySection = {}
    const presentKeysBySection = {}
    let totalKeyCount = 0
    let filledKeyCount = 0

    supportedSectionKeys.forEach(sectionKey => {
      const sectionData = existingSectionMap.get(sectionKey)
      const schema = PROFILE_SCHEMA?.[sectionKey]
      const canonicalKeys = Object.keys(schema?.fields ?? {})
      
      if (!sectionData) {
        missingSections.push(sectionKey)
        missingKeysBySection[sectionKey] = canonicalKeys
        presentKeysBySection[sectionKey] = []
      } else {
        // Canonical keys: enforce presence even if missing in saved JSON.
        // For completion scoring, we only score canonical keys (not arbitrary extras).
        const keys = canonicalKeys.filter((k) => k !== 'notes')
        const presentKeys = keys.filter((k) => Object.prototype.hasOwnProperty.call(sectionData, k))
        const missingKeys = keys.filter((k) => !Object.prototype.hasOwnProperty.call(sectionData, k))

        presentKeysBySection[sectionKey] = presentKeys
        missingKeysBySection[sectionKey] = missingKeys

        const filledKeys = keys.filter((k) => {
          const value = sectionData[k]
          if (value === null || value === undefined || value === '') return false
          if (Array.isArray(value) && value.length === 0) return false
          if (typeof value === 'object' && value && Object.keys(value).length === 0) return false
          return true
        })

        totalKeyCount += keys.length
        filledKeyCount += filledKeys.length

        if (filledKeys.length === 0) {
          emptySections.push(sectionKey)
        } else {
          completedSections.push({
            section_key: sectionKey,
            filled_keys: filledKeys.length,
            total_keys: keys.length,
            missing_keys: missingKeys.length,
          })
        }
      }
    })

    const percentComplete = totalKeyCount > 0 
      ? Math.round((filledKeyCount / totalKeyCount) * 100) 
      : 0

    res.json({
      profile_id: id,
      display_name: profile.display_name,
      total_canonical_sections: supportedSectionKeys.length,
      missing_sections: missingSections,
      empty_sections: emptySections,
      completed_sections: completedSections,
      missing_keys_by_section: missingKeysBySection,
      present_keys_by_section: presentKeysBySection,
      percent_complete: percentComplete,
      summary: {
        missing: missingSections.length,
        empty: emptySections.length,
        with_data: completedSections.length,
        filled_keys: filledKeyCount,
        total_keys: totalKeyCount,
        missing_keys: Object.values(missingKeysBySection).reduce((acc, arr) => acc + (arr?.length ?? 0), 0),
      }
    })
  } catch (error) {
    console.error('Error checking profile completeness:', error)
    res.status(500).json(formatError(error))
  }
})

// Profile repair - create missing sections with empty JSON
// POST /api/profiles/:id/repair
router.post('/:id/repair', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profile = await req.db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get existing sections
    const existingSections = await req.db
      .prepare('SELECT section_key FROM profile_sections WHERE profile_id = ?')
      .all(id)
    
    const existingKeys = new Set(existingSections.map(s => s.section_key))

    // Create missing sections (as empty JSON)
    const upsert = req.db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, '{}', 'system-repair')
      ON CONFLICT(profile_id, section_key) DO NOTHING
    `)

    const createdSections = []
    for (const sectionKey of supportedSectionKeys) {
      if (!existingKeys.has(sectionKey)) {
        await upsert.run(id, sectionKey)
        createdSections.push(sectionKey)
      }
    }

    // Ensure every canonical key exists in every section (data-point completeness).
    // This is safe because profile_sections.data is JSON and adding keys is backward compatible.
    const existingSectionRows = await req.db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(id)

    const updateStmt = req.db.prepare(`
      UPDATE profile_sections
      SET data = ?, updated_by = 'system-repair', updated_at = CURRENT_TIMESTAMP
      WHERE profile_id = ? AND section_key = ?
    `)

    const repairedKeysBySection = {}
    for (const row of existingSectionRows) {
      const sectionKey = row.section_key
      if (!supportedSectionKeys.includes(sectionKey)) continue

      const current = safeParseJSON(row.data, {})
      const defaults = getDefaultSectionData(sectionKey)
      const repairedKeys = []

      for (const [key, defaultValue] of Object.entries(defaults)) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          current[key] = defaultValue
          repairedKeys.push(key)
        }
      }

      if (repairedKeys.length > 0) {
        repairedKeysBySection[sectionKey] = repairedKeys
        await updateStmt.run(JSON.stringify(current), id, sectionKey)
      }
    }

    res.json({
      success: true,
      profile_id: id,
      display_name: profile.display_name,
      sections_created: createdSections,
      keys_repaired_by_section: repairedKeysBySection,
      total_sections_after: supportedSectionKeys.length,
      message: createdSections.length > 0 
        ? `Created ${createdSections.length} missing section(s)` 
        : 'Profile already has all sections'
    })
  } catch (error) {
    console.error('Error repairing profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Export profile as JSON
// GET /api/profiles/:id/export
router.get('/:id/export', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const profileRow = await req.db.prepare(`${profileSelect} WHERE p.id = ?`).get(id)
    if (!profileRow) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const profile = mapProfile(profileRow)

    // Get all sections
    const sections = (await req.db
      .prepare('SELECT section_key, data, updated_at FROM profile_sections WHERE profile_id = ?')
      .all(id))
      .reduce((acc, row) => {
        acc[row.section_key] = {
          data: safeParseJSON(row.data, {}),
          updated_at: row.updated_at
        }
        return acc
      }, {})

    const exportData = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      profile: {
        id: profile.id,
        display_name: profile.display_name,
        primary_type: profile.primary_type,
        status: profile.status,
        tags: profile.tags,
        avatar_url: profile.avatar_url,
        created_at: profile.created_at,
        updated_at: profile.updated_at
      },
      sections
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename="profile-${id}-export.json"`)
    res.json(exportData)
  } catch (error) {
    console.error('Error exporting profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Import profile from JSON
// POST /api/profiles/:id/import
router.post('/:id/import', async (req, res) => {
  const { id } = req.params

  if (!canAccessProfileIdFromCtx(req.ctx, id)) return denyAuth(req, res)

  try {
    const { sections, merge = true } = req.body ?? {}

    if (!sections || typeof sections !== 'object') {
      return res.status(400).json({ error: 'sections object required in request body' })
    }

    const profile = await req.db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(id)
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const importedSections = []

    await req.db.withTransaction(async (tx) => {
      const upsert = tx.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
        VALUES (?, ?, ?, 'import')
        ON CONFLICT(profile_id, section_key) DO UPDATE SET
          data = excluded.data,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
      `)

      for (const [sectionKey, sectionValue] of Object.entries(sections)) {
        if (!supportedSectionKeys.includes(sectionKey)) {
          console.warn(`Skipping unknown section key: ${sectionKey}`)
          continue
        }

        const data = sectionValue?.data ?? sectionValue
        if (typeof data !== 'object' || data === null) {
          console.warn(`Skipping invalid section data for: ${sectionKey}`)
          continue
        }

        if (merge) {
          // Merge with existing data
          const existing = await tx
            .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
            .get(id, sectionKey)
          
          const existingData = existing ? safeParseJSON(existing.data, {}) : {}
          const mergedData = { ...existingData, ...data }
          await upsert.run(id, sectionKey, JSON.stringify(mergedData))
        } else {
          // Replace existing data
          await upsert.run(id, sectionKey, JSON.stringify(data))
        }

        importedSections.push(sectionKey)
      }
    })

    res.json({
      success: true,
      profile_id: id,
      display_name: profile.display_name,
      sections_imported: importedSections,
      merge_mode: merge,
      message: `Imported ${importedSections.length} section(s)`
    })
  } catch (error) {
    console.error('Error importing profile:', error)
    res.status(500).json(formatError(error))
  }
})

// Send application email (for draft applications or completed profiles)
router.post('/send-application-email', async (req, res) => {
  try {
    // Use environment variable with fallback, or require toEmail in request
    const defaultEmail = process.env.APPLICATION_EMAIL || null
    const { toEmail = defaultEmail, applicationData } = req.body

    if (!toEmail) {
      return res.status(400).json({ 
        error: 'Recipient email required',
        message: 'Please provide a toEmail in the request body or set APPLICATION_EMAIL environment variable'
      })
    }

    // Import email service
    const { sendApplicationEmail } = await import('../services/email.js')

    // Send the email
    const sent = await sendApplicationEmail(toEmail, applicationData)

    if (!sent) {
      return res.status(500).json({ 
        error: 'Email service not configured or failed to send',
        message: 'Please check email service configuration'
      })
    }

    res.json({ 
      success: true,
      message: `Application sent to ${toEmail}` 
    })
  } catch (error) {
    console.error('Error sending application email:', error)
    res.status(500).json(formatError(error))
  }
})

export default router
