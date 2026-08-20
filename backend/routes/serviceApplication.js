import express from 'express'
import crypto from 'crypto'
import { sendServiceApplicationEmail } from '../services/email.js'
import { sensitiveRateLimiter } from '../middleware/rateLimiting.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'
import { convertApplicationToProfile } from '../services/serviceApplicationConversion.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:serviceApplication')

const router = express.Router()

// Email recipient for service applications and contact forms.
// Must be set via SERVICE_APPLICATION_EMAIL environment variable.
const SERVICE_APPLICATION_EMAIL = process.env.SERVICE_APPLICATION_EMAIL || null
if (!SERVICE_APPLICATION_EMAIL) {
  console.warn(
    '[serviceApplication] WARNING: SERVICE_APPLICATION_EMAIL env var is not set. ' +
    'Service application and contact form emails will not be sent.',
  )
}

function normalizeEmail(value) {
  const v = String(value || '').trim().toLowerCase()
  return v || null
}

async function hardDeleteProfileWithFallback(db, profileId) {
  const id = String(profileId || '').trim()
  if (!id) return { ok: false, error: 'profile_id_required' }

  const dialect = db?.dialect || 'sqlite'
  // nowSql removed — inline literals are used directly in both UPDATE statements below

  // Designated/demo profiles should never be hard-deleted (boot seeding may resurrect).
  if (isDesignatedProfileId(id)) {
    const updateSql = dialect === 'postgres'
    ? 'UPDATE profiles SET status = \'deleted\', updated_at = now() WHERE id = ?'
    : 'UPDATE profiles SET status = \'deleted\', updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  try {
    await db.prepare(updateSql).run(id)
  } catch (err) {
    return { ok: false, deleted: 'none', error: err?.message || String(err) }
  }
  return { ok: true, deleted: 'soft', reason: 'designated_profile' }
  }

  try {
    await db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
    return { ok: true, deleted: 'hard' }
  } catch (err) {
    // If FK constraints prevent delete, fall back to a durable soft-delete.
    const fallbackSql = dialect === 'postgres'
      ? 'UPDATE profiles SET status = \'deleted\', updated_at = now() WHERE id = ?'
      : 'UPDATE profiles SET status = \'deleted\', updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    await db.prepare(fallbackSql).run(id)
    return { ok: true, deleted: 'soft', error: err?.message || String(err) }
  }
}

/**
 * Helper to save application to database
 */
async function saveApplicationToDb(db, data) {
  const id = crypto.randomUUID()
  
  try {
    await db.prepare(`
      INSERT INTO service_applications (
        id, type, full_name, email, phone, organization, title,
        client_category, selected_services, total_cost,
        subject, message, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `).run(
      id,
      data.type || 'service_application',
      data.fullName || data.name || '',
      data.email || '',
      data.phone || null,
      data.organization || null,
      data.title || null,
      data.clientCategory || null,
      JSON.stringify(data.selectedServices || []),
      data.totalCost || null,
      data.subject || null,
      data.message || null
    )
    
    routeLogger.info('[serviceApplication] Saved to database:', id)
    return id
  } catch (error) {
    console.warn('[serviceApplication] Could not save to DB:', error.message)
    // Re-throw for critical errors, return null only for missing table
    if (!error.message?.includes('no such table') && !error.message?.includes('does not exist')) {
      throw error
    }
    console.error('[serviceApplication] service_applications table missing — submission NOT persisted to DB. applicationId will be null.', { type: data.type, email: data.email })
    return null
  }
}

/**
 * POST /api/service-application
 * Generic endpoint for contact forms and service applications
 */
// These two endpoints are intentionally public (contact form + service-application
// intake — no login). They write a DB row and trigger an outbound email, so they
// are throttled with the strict 5/min/IP limiter to prevent email-bombing and
// storage-exhaustion by anonymous callers.
router.post('/', sensitiveRateLimiter, async (req, res) => {
  try {
    const { type, name, email, subject, message } = req.body // recipient intentionally omitted — always use SERVICE_APPLICATION_EMAIL

    // Handle contact_admin type
    if (type === 'contact_admin') {
      // Validate required fields
      if (!name || !email || !subject || !message) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
        })
      }

      // Validate email format
      const emailRegex = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email format',
        })
      }

      // Save to database
    const applicationId = await saveApplicationToDb(req.db, {
        type: 'contact_admin',
        name,
        email,
        subject,
        message,
      })

      // Send email notification to admin
      const emailContent = {
        type: 'contact_admin',
        name,
        email,
        subject,
        message,
        submittedAt: new Date().toISOString(),
      }

      // Send to admin email (determined server-side, not from client).
      // The row is saved either way, so `success` stays true — but the
      // RESPONSE MUST NOT CLAIM A SEND THAT DID NOT HAPPEN. With
      // SERVICE_APPLICATION_EMAIL unset (the default — it is commented out in
      // .env.example and no boot check requires it) this branch warns to a log
      // nobody reads and used to answer "Message sent successfully", while
      // module load had already warned "…emails will not be sent." The caller
      // was told the opposite of what the process knew. Mirrors the
      // `email_sent` + reason shape auth.js already uses for OTP delivery.
      let notificationSent = false
      if (SERVICE_APPLICATION_EMAIL) {
        await sendServiceApplicationEmail(SERVICE_APPLICATION_EMAIL, emailContent)
        notificationSent = true
      } else {
        console.warn('[serviceApplication] Skipping contact email — SERVICE_APPLICATION_EMAIL not configured.')
      }

      return res.json({
        success: true,
        message: notificationSent
          ? 'Message sent successfully'
          : 'Message recorded. Admin email notification is not configured, so nothing was emailed.',
        notification_sent: notificationSent,
        notification_error: notificationSent ? null : 'admin_email_not_configured',
        applicationId,
      })
    }

    // Default: return error for unknown types
    return res.status(400).json({
      success: false,
      message: 'Invalid request type',
    })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error:', error)
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process request',
    })
  }
})

/**
 * POST /api/service-application/submit
 * Submit a service application and send via email
 */
router.post('/submit', sensitiveRateLimiter, async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      organization,
      title,
      clientCategory,
      selectedServices,
      totalCost,
      submittedAt,
    } = req.body

    // Validate required fields
    if (!fullName || !email || !clientCategory || !selectedServices || selectedServices.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
      })
    }

    // Validate email format
    const emailRegex = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
      })
    }

    // Save to database
    const applicationId = await saveApplicationToDb(req.db, {
      type: 'service_application',
      fullName,
      email,
      phone,
      organization,
      title,
      clientCategory,
      selectedServices,
      totalCost,
    })

    // Format the application data for email
    const applicationData = {
      fullName,
      email,
      phone: phone || 'Not provided',
      organization: organization || 'Not provided',
      title: title || 'Not provided',
      clientCategory,
      selectedServices,
      totalCost,
      submittedAt: submittedAt || new Date().toISOString(),
    }

    // Send the email. Same rule as the contact branch above: the application
    // row is persisted regardless, but an unconfigured recipient must not be
    // reported as a delivered notification.
    let notificationSent = false
    if (SERVICE_APPLICATION_EMAIL) {
      await sendServiceApplicationEmail(SERVICE_APPLICATION_EMAIL, applicationData)
      notificationSent = true
    } else {
      console.warn('[serviceApplication] Skipping application email — SERVICE_APPLICATION_EMAIL not configured.')
    }

    res.json({
      success: true,
      message: notificationSent
        ? 'Application submitted successfully'
        : 'Application recorded. Admin email notification is not configured, so nothing was emailed.',
      notification_sent: notificationSent,
      notification_error: notificationSent ? null : 'admin_email_not_configured',
      applicationId,
    })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error submitting application:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit application',
    })
  }
})

/**
 * GET /api/service-application/list
 * List all service applications (admin only)
 */
router.get('/list', async (req, res) => {
  try {
    if (!req.ctx || !req.ctx.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      })
    }

    const { status, limit = 50, offset = 0 } = req.query
    
    let query = 'SELECT * FROM service_applications'
    const params = []
    
    if (status) {
      query += ' WHERE status = ?'
      params.push(status)
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(parseInt(limit), parseInt(offset))
    
    let applications = []
    let total = { count: 0 }
    try {
      applications = await req.db.prepare(query).all(...params)
      const countQuery = status
        ? 'SELECT COUNT(*) as count FROM service_applications WHERE status = ?'
        : 'SELECT COUNT(*) as count FROM service_applications'
      total = status
        ? await req.db.prepare(countQuery).get(status)
        : await req.db.prepare(countQuery).get()
    } catch (dbError) {
      const msg = String(dbError?.message || dbError)
      const missingTable =
        msg.includes('no such table: service_applications') ||
        msg.includes('relation "service_applications" does not exist')
      if (!missingTable) throw dbError
      // If the table doesn't exist yet (new environment), return an empty list instead of 500.
      applications = []
      total = { count: 0 }
    }
    
    res.json({
      success: true,
      applications: applications.map(app => ({
        ...app,
        selected_services: JSON.parse(app.selected_services || '[]'),
      })),
      total: total.count,
    })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error listing applications:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list applications',
    })
  }
})

/**
 * PATCH /api/service-application/:id
 * Update application status (admin only)
 */
router.patch('/:id', async (req, res) => {
  try {
    // Check admin access (canonical)
    if (!req.ctx || !req.ctx.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      })
    }

    const { id } = req.params
    const { status, notes, profile_id } = req.body

    const updates = []
    const params = []

    // Must match the service_applications.status CHECK constraint (schema.sql /
    // postgres 0001_init.sql) — 'approved'/'rejected' were listed here once but
    // violate the DB CHECK and 500'd the request.
    const ALLOWED_STATUSES = ['new', 'reviewed', 'contacted', 'converted', 'archived']
    if (status) {
      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status value. Allowed: ${ALLOWED_STATUSES.join(', ')}` })
      }
      updates.push('status = ?')
      params.push(status)
      if (status === 'reviewed') {
        updates.push('reviewed_by = ?')
        params.push(req.ctx?.userId || null)
        updates.push('reviewed_at = CURRENT_TIMESTAMP')
      }
    }

    // "Convert" must actually convert: create-or-link the client profile so it
    // shows up in the admin profile list and the applicant's email can log in.
    // (Previously this route only flipped the status flag — the application
    // read "converted" while no profile existed anywhere.)
    let conversion = null
    if (status === 'converted') {
      const app = await req.db.prepare('SELECT * FROM service_applications WHERE id = ?').get(id)
      if (!app) {
        return res.status(404).json({ success: false, message: 'Application not found' })
      }
      const requestedProfileId = profile_id ? String(profile_id).trim() : null
      conversion = await convertApplicationToProfile(
        req.db,
        { ...app, profile_id: requestedProfileId || app.profile_id },
        { actor: req.ctx?.email || req.ctx?.userId || 'admin' },
      )
      if (!conversion.ok) {
        return res.status(409).json({
          success: false,
          message: 'Multiple existing profiles match this applicant; link one explicitly via profile_id.',
          candidates: conversion.candidates,
        })
      }
    }

    if (notes !== undefined) {
      updates.push('notes = ?')
      params.push(notes)
    }

    if (profile_id) {
      updates.push('profile_id = ?')
      params.push(profile_id)
    }

    // Guard: require at least one meaningful field before running the UPDATE
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updatable fields provided' })
    }

    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(id)
    
    await req.db.prepare(`
      UPDATE service_applications
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params)
    
    const updated = await req.db.prepare('SELECT * FROM service_applications WHERE id = ?').get(id)
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Application not found' })
    }
    res.json({
      success: true,
      application: updated,
      ...(conversion
        ? {
            conversion: {
              profile_id: conversion.profileId,
              created: conversion.created,
              matched_by: conversion.matchedBy,
            },
          }
        : {}),
    })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error updating application:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update application',
    })
  }
})

/**
 * DELETE /api/service-application/:id
 * Delete a service application row (admin only)
 */
router.delete('/:id', async (req, res) => {
  try {
    if (!req.ctx || !req.ctx.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      })
    }

    const { id } = req.params
    const row = await req.db.prepare('SELECT id FROM service_applications WHERE id = ?').get(id)
    if (!row) {
      return res.status(404).json({ success: false, message: 'Application not found' })
    }

    await req.db.prepare('DELETE FROM service_applications WHERE id = ?').run(id)
    return res.json({ success: true, deleted: true })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error deleting application:', error)
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete application',
    })
  }
})

/**
 * POST /api/service-application/:id/delete-profile
 *
 * Admin-only: delete the profile created from an application.
 *
 * Strategy:
 * - Prefer service_applications.profile_id when present.
 * - Else, match by email against profile_sections.basic_information.email.
 *   - If exactly 1 match: delete it.
 *   - If 0 matches: 404
 *   - If >1 matches: 409 with candidates (force manual selection via Profiles UI)
 */
router.post('/:id/delete-profile', async (req, res) => {
  try {
    if (!req.ctx || !req.ctx.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      })
    }

    const { id } = req.params
    const app = await req.db.prepare('SELECT * FROM service_applications WHERE id = ?').get(id)
    if (!app) {
      return res.status(404).json({ success: false, message: 'Application not found' })
    }

    const dialect = req.db?.dialect || 'sqlite'
    const email = normalizeEmail(app?.email)

    let targetProfileId = app?.profile_id ? String(app.profile_id).trim() : null
    let candidates = []

    if (!targetProfileId) {
      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'No linked profile_id and no email available to match',
        })
      }

      try {
        if (dialect === 'postgres') {
          candidates = await req.db
            .prepare(
              `
                SELECT DISTINCT p.id, p.display_name
                FROM profiles p
                JOIN profile_sections ps ON ps.profile_id = p.id
                WHERE ps.section_key = 'basic_information'
                  AND LOWER((ps.data::jsonb ->> 'email')) = ?
                  AND (p.status IS NULL OR lower(p.status) <> 'deleted')
                ORDER BY COALESCE(p.updated_at, p.created_at) DESC
                LIMIT 25
              `,
            )
            .all(email)
        } else {
          candidates = await req.db
            .prepare(
              `
                SELECT DISTINCT p.id, p.display_name
                FROM profiles p
                JOIN profile_sections ps ON ps.profile_id = p.id
                WHERE ps.section_key = 'basic_information'
                  AND LOWER(json_extract(ps.data, '$.email')) = ?
                  AND (p.status IS NULL OR lower(p.status) <> 'deleted')
                ORDER BY COALESCE(p.updated_at, p.created_at) DESC
                LIMIT 25
              `,
            )
            .all(email)
        }
      } catch (queryError) {
        console.warn('[serviceApplication] Failed to locate profile by email:', queryError?.message || queryError)
        candidates = []
      }

      if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No matching active profile found for this application email',
        })
      }

      if (candidates.length > 1) {
        return res.status(409).json({
          success: false,
          message: 'Multiple profiles match this application email; delete manually from Profiles.',
          candidates: candidates.map((c) => ({ id: c.id, display_name: c.display_name })),
        })
      }

      targetProfileId = String(candidates[0].id).trim()
    }

    // Delete the profile, then unlink the application record (keep the audit trail).
    const deleted = await hardDeleteProfileWithFallback(req.db, targetProfileId)
    await req.db
      .prepare('UPDATE service_applications SET profile_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(id)

    return res.json({
      success: true,
      profile_id: targetProfileId,
      delete_result: deleted,
      matched_candidates: candidates?.length ? candidates : undefined,
    })
  } catch (error) {
    routeLogger.error('[serviceApplication] Error deleting linked profile:', error)
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete profile',
    })
  }
})

export default router
