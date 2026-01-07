import express from 'express'
import { sendServiceApplicationEmail } from '../services/email.js'

const router = express.Router()

// Email recipient for service applications
const SERVICE_APPLICATION_EMAIL = process.env.SERVICE_APPLICATION_EMAIL || 'dr.johnwhite@axiombiolabs.org'

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
