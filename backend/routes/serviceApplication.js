import express from 'express'
import { sendServiceApplicationEmail } from '../services/email.js'

const router = express.Router()

// Email recipient for service applications and contact forms
const SERVICE_APPLICATION_EMAIL = process.env.SERVICE_APPLICATION_EMAIL || 'dr.johnwhite@axiombiolabs.org'

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

      // Send email notification to admin
      const recipientEmail = recipient || SERVICE_APPLICATION_EMAIL
      const emailContent = {
        type: 'contact_admin',
        name,
        email,
        subject,
        message,
        submittedAt: new Date().toISOString(),
      }

      await sendServiceApplicationEmail(recipientEmail, emailContent)

      return res.json({
        success: true,
        message: 'Message sent successfully',
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
    })
  } catch (error) {
    console.error('[serviceApplication] Error submitting application:', error)
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit application',
    })
  }
})

export default router
