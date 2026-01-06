import { Resend } from 'resend'

const RESEND_API_KEY = process.env.RESEND_API_KEY || null
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'

let resendClient = null
if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY)
    console.info('[email] Email service initialized successfully with FROM_EMAIL:', FROM_EMAIL)
  } catch (error) {
    console.error('[email] Failed to initialize Resend client:', error.message)
  }
} else {
  console.warn('[email] Email service NOT configured - RESEND_API_KEY is missing')
  console.warn('[email] Email authentication will work but codes will only be available in response/logs')
}

/**
 * Check if email service is configured
 * @returns {boolean} True if email service is available
 */
export function isEmailServiceConfigured() {
  return resendClient !== null
}

/**
 * Send a verification email with a 6-digit code
 * @param {string} email - Recipient email address
 * @param {string} code - 6-digit verification code
 * @returns {Promise<boolean>} True if email was sent successfully, false otherwise
 */
export async function sendVerificationEmail(email, code) {
  if (!email || typeof email !== 'string') {
    console.error('[email] Invalid email address provided:', email)
    return false
  }
  
  if (!code || typeof code !== 'string') {
    console.error('[email] Invalid verification code provided')
    return false
  }
  
  if (!resendClient) {
    console.warn('[email] Email service not configured. RESEND_API_KEY is missing from environment variables.')
    console.warn('[email] Code for', email, ':', code)
    return false
  }

  try {
    const result = await resendClient.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Your GrantFlow verification code',
      html: `
        <h2>GrantFlow Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="font-size:32px;letter-spacing:5px;">${code}</h1>
        <p>This code expires in 10 minutes.</p>
      `,
    })
    console.info('[email] Verification email sent successfully to', email, 'ID:', result?.id)
    return true
  } catch (error) {
    console.error('[email] Failed to send verification email:', error?.message || error)
    console.error('[email] Error details:', { email, hasCode: !!code, fromEmail: FROM_EMAIL })
    return false
  }
}

/**
 * Send an application submission email
 * @param {string} toEmail - Recipient email address
 * @param {Object} applicationData - Application data to format and send
 * @returns {Promise<boolean>} True if email was sent successfully
 * @throws {Error} If email service is not configured or sending fails
 */
export async function sendApplicationEmail(toEmail, applicationData) {
  if (!toEmail || typeof toEmail !== 'string') {
    throw new Error('Invalid email address')
  }
  
  if (!applicationData || typeof applicationData !== 'object') {
    throw new Error('Invalid application data')
  }
  
  if (!resendClient) {
    const errorMsg = 'Email service not configured. RESEND_API_KEY is missing from environment variables.'
    console.error('[email]', errorMsg, 'Would send application to:', toEmail)
    throw new Error(errorMsg)
  }

  try {
    // Format application data as HTML
    const htmlContent = formatApplicationAsHTML(applicationData)
    
    await resendClient.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `New Application Submitted - ${applicationData.name || 'Applicant'}`,
      html: htmlContent,
    })
    return true
  } catch (error) {
    console.error('[email] Failed to send application:', error?.message || error)
    throw new Error(`Failed to send application email: ${error?.message || 'Unknown error'}`)
  }
}

function formatApplicationAsHTML(data) {
  const sections = []
  
  // Basic Information
  sections.push(`
    <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">Application Information</h2>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr><td style="padding: 8px; font-weight: bold; width: 200px;">Applicant Type:</td><td style="padding: 8px;">${data.applicant_type?.replace(/_/g, ' ') || 'N/A'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Name:</td><td style="padding: 8px;">${data.name || 'N/A'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Date of Birth:</td><td style="padding: 8px;">${data.date_of_birth || 'N/A'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td style="padding: 8px;">${Array.isArray(data.email) ? data.email.join(', ') : data.email || 'N/A'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Phone:</td><td style="padding: 8px;">${Array.isArray(data.phone) ? data.phone.join(', ') : data.phone || 'N/A'}</td></tr>
    </table>
  `)

  // Address
  if (data.city || data.state || data.zip) {
    sections.push(`
      <h3 style="color: #1e40af; margin-top: 20px;">Address</h3>
      <p style="margin: 10px 0;">${data.address || ''}<br>${data.city || ''}, ${data.state || ''} ${data.zip || ''}</p>
    `)
  }

  // Organization Details
  if (data.applicant_type === 'organization') {
    sections.push(`
      <h3 style="color: #1e40af; margin-top: 20px;">Organization Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px; font-weight: bold; width: 200px;">EIN:</td><td style="padding: 8px;">${data.organization_ein || 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">UEI:</td><td style="padding: 8px;">${data.organization_uei || 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Website:</td><td style="padding: 8px;">${data.website || 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Annual Budget:</td><td style="padding: 8px;">${data.annual_budget ? '$' + data.annual_budget.toLocaleString() : 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Staff Count:</td><td style="padding: 8px;">${data.staff_count || 'N/A'}</td></tr>
      </table>
    `)
  }

  // Financial Information
  if (data.household_income || data.household_size) {
    sections.push(`
      <h3 style="color: #1e40af; margin-top: 20px;">Financial Situation</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 8px; font-weight: bold; width: 200px;">Household Income:</td><td style="padding: 8px;">${data.household_income ? '$' + data.household_income.toLocaleString() : 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Household Size:</td><td style="padding: 8px;">${data.household_size || 'N/A'}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold;">Financial Need Level:</td><td style="padding: 8px;">${data.financial_need_level || 'N/A'}</td></tr>
      </table>
    `)
  }

  // Narrative
  if (data.mission || data.primary_goal || data.special_circumstances) {
    sections.push(`
      <h3 style="color: #1e40af; margin-top: 20px;">Story & Goals</h3>
      ${data.mission ? `<p style="margin: 10px 0;"><strong>Mission:</strong> ${data.mission}</p>` : ''}
      ${data.primary_goal ? `<p style="margin: 10px 0;"><strong>Primary Goal:</strong> ${data.primary_goal}</p>` : ''}
      ${data.past_experience ? `<p style="margin: 10px 0;"><strong>Past Experience:</strong> ${data.past_experience}</p>` : ''}
      ${data.special_circumstances ? `<p style="margin: 10px 0;"><strong>Special Circumstances:</strong> ${data.special_circumstances}</p>` : ''}
      ${data.funding_amount_needed ? `<p style="margin: 10px 0;"><strong>Funding Needed:</strong> ${data.funding_amount_needed}</p>` : ''}
    `)
  }

  // Qualifications (checkboxes that are checked)
  const qualifications = []
  Object.keys(data).forEach(key => {
    if (data[key] === true) {
      qualifications.push(key.replace(/_/g, ' '))
    }
  })

  if (qualifications.length > 0) {
    sections.push(`
      <h3 style="color: #1e40af; margin-top: 20px;">Qualifications & Characteristics</h3>
      <ul style="margin: 10px 0;">
        ${qualifications.map(q => `<li style="margin: 5px 0;">${q}</li>`).join('')}
      </ul>
    `)
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
      </style>
    </head>
    <body>
      <h1 style="color: #1e40af; border-bottom: 3px solid #2563eb; padding-bottom: 10px;">GrantFlow Application</h1>
      <p style="color: #666; margin-bottom: 30px;">Submitted on ${new Date().toLocaleDateString()}</p>
      ${sections.join('\n')}
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #ccc;">
      <p style="color: #666; font-size: 12px; text-align: center;">
        This application was submitted through GrantFlow<br>
        For questions, contact: Dr.JohnWhite@axiombiolabs.org
      </p>
    </body>
    </html>
  `
}
