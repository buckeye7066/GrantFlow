import express from 'express'
import crypto from 'crypto'
import { sendServiceApplicationEmail } from '../services/email.js'

const router = express.Router()

// Email recipient for service applications and contact forms
const SERVICE_APPLICATION_EMAIL = process.env.SERVICE_APPLICATION_EMAIL || 'dr.johnwhite@axiombiolabs.org'

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
    
    console.log('[serviceApplication] Saved to database:', id)
    return id
  } catch (error) {
    // Table might not exist yet - log but don't fail
    console.warn('[serviceApplication] Could not save to DB:', error.message)
    return null
  }
}

/**
 * POST /api/service-application
 * Generic endpoint for contact forms and service applications
 */
router.post('/', async (req, res) => {
  try {
    const { type, name, email, subject, message, recipient } = req.body

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
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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

      // Always send to admin email (determined server-side, not from client)
      await sendServiceApplicationEmail(SERVICE_APPLICATION_EMAIL, emailContent)

      return res.json({
        success: true,
        message: 'Message sent successfully',
        applicationId,
      })
    }

    // Default: return error for unknown types
    return res.status(400).json({
      success: false,
      message: 'Invalid request type',
    })
  } catch (error) {
    console.error('[serviceApplication] Error:', error)
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
router.post('/submit', async (req, res) => {
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
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
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

    // Send the email
    await sendServiceApplicationEmail(SERVICE_APPLICATION_EMAIL, applicationData)

    res.json({
      success: true,
      message: 'Application submitted successfully',
      applicationId,
    })
  } catch (error) {
    console.error('[serviceApplication] Error submitting application:', error)
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
    // Check admin access
    const user = req.user
    const isAdmin = Boolean(user?.is_admin) || user?.role === 'admin' ||
      (user?.primary_email && user.primary_email.toLowerCase().includes('buckeye7066'))
    
    if (!isAdmin) {
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
      total = await req.db.prepare('SELECT COUNT(*) as count FROM service_applications').get()
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
    console.error('[serviceApplication] Error listing applications:', error)
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
    // Check admin access
    const user = req.user
    const isAdmin = Boolean(user?.is_admin) || user?.role === 'admin' ||
      (user?.primary_email && user.primary_email.toLowerCase().includes('buckeye7066'))
    
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required',
      })
    }

    const { id } = req.params
    const { status, notes, profile_id } = req.body
    
    const updates = []
    const params = []
    
    if (status) {
      updates.push('status = ?')
      params.push(status)
      
      if (status === 'reviewed') {
        updates.push('reviewed_by = ?', 'reviewed_at = CURRENT_TIMESTAMP')
        params.push(user?.userId || user?.id || null)
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
    
    updates.push('updated_at = CURRENT_TIMESTAMP')
    params.push(id)
    
    await req.db.prepare(`
      UPDATE service_applications
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...params)
    
    const updated = await req.db.prepare('SELECT * FROM service_applications WHERE id = ?').get(id)
    
    res.json({
      success: true,
      application: updated,
    })
  } catch (error) {
    console.error('[serviceApplication] Error updating application:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update application',
    })
  }
})

export default router
