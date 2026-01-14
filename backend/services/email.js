/**
 * Email service using Resend
 * Falls back gracefully when Resend is not available or configured
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || null
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev'
const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app'
const AUTH_NOTIFY_EMAIL = process.env.AUTH_NOTIFY_EMAIL || null
const AUTH_NOTIFY_ON_LOGIN = String(process.env.AUTH_NOTIFY_ON_LOGIN || '').toLowerCase() === 'true'

let resendClient = null
let initPromise = null

// Initialize Resend client lazily
async function getResendClient() {
  if (resendClient) return resendClient
  
  if (!RESEND_API_KEY) {
    console.warn('[email] Email service NOT configured - RESEND_API_KEY is missing')
    console.warn('[email] Email authentication will work but codes will only be available in response/logs')
    return null
  }
  
  // If already initializing, wait for it
  if (initPromise) {
    return initPromise
  }
  
  initPromise = (async () => {
    try {
      const { Resend } = await import('resend')
      resendClient = new Resend(RESEND_API_KEY)
      console.info('[email] Email service initialized successfully with FROM_EMAIL:', FROM_EMAIL)
      return resendClient
    } catch (error) {
      console.error('[email] Failed to load Resend package:', error.message)
      console.error('[email] Run: npm install resend')
      return null
    }
  })()
  
  return initPromise
}

/**
 * Check if email service is configured
 * @returns {boolean} True if email service is available
 */
export function isEmailServiceConfigured() {
  return !!RESEND_API_KEY
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
  
  const client = await getResendClient()
  
  if (!client) {
    console.warn('[email] Email service not configured. RESEND_API_KEY is missing from environment variables.')
    console.warn('[email] Code for', email, ':', code)
    // Return false to indicate email wasn't sent, allowing fallback to preview code
    return false
  }

  try {
    // Add a timeout wrapper to prevent hanging
    const sendWithTimeout = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Email send timeout after 5 seconds'))
      }, 5000) // 5 second timeout
      
      client.emails.send({
        from: FROM_EMAIL,
        to: email,
        subject: 'Your GrantFlow verification code',
        html: `
          <h2>GrantFlow Verification</h2>
          <p>Your verification code is:</p>
          <h1 style="font-size:32px;letter-spacing:5px;">${code}</h1>
          <p>This code expires in 10 minutes.</p>
        `,
      }).then(result => {
        clearTimeout(timeout)
        resolve(result)
      }).catch(error => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    
    const result = await sendWithTimeout
    console.info('[email] Verification email sent successfully to', email, 'ID:', result?.id)
    return true
  } catch (error) {
    console.error('[email] Failed to send verification email:', error?.message || error)
    console.error('[email] Error details:', { email, hasCode: !!code, fromEmail: FROM_EMAIL })
    // Return false instead of throwing, so the code can still be displayed
    return false
  }
}

/**
 * Optional: Send an admin alert when users attempt to authenticate (start/verify).
 * Controlled by env vars:
 * - AUTH_NOTIFY_ON_LOGIN=true (enable)
 * - AUTH_NOTIFY_EMAIL=ops@... (optional override destination; otherwise ADMIN_EMAIL)
 *
 * This NEVER includes the verification code.
 */
export async function sendAuthAttemptNotification(
  { event, identifier, success, error, context } = {},
) {
  if (!AUTH_NOTIFY_ON_LOGIN && !AUTH_NOTIFY_EMAIL) {
    return false
  }

  const client = await getResendClient()
  if (!client) {
    return false
  }

  const to = AUTH_NOTIFY_EMAIL || DEFAULT_ADMIN_EMAIL
  const safeIdentifier = typeof identifier === 'string' ? identifier : 'unknown'
  const safeEvent = typeof event === 'string' ? event : 'auth_event'
  const ok = Boolean(success)
  const safeError = error ? String(error).slice(0, 500) : null
  const ctx = context && typeof context === 'object' ? context : null
  const safeCtx = ctx
    ? {
        method: ctx.method ? String(ctx.method).slice(0, 64) : null,
        user_id: ctx.userId ? String(ctx.userId).slice(0, 128) : null,
        profile_id: ctx.profileId ? String(ctx.profileId).slice(0, 128) : null,
        ip: ctx.ip ? String(ctx.ip).slice(0, 128) : null,
        user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 256) : null,
      }
    : null

  try {
    const title =
      safeEvent === 'sign_in'
        ? 'User signed in'
        : safeEvent === 'email_verify'
          ? 'Email verification'
          : safeEvent === 'phone_verify'
            ? 'Phone verification'
            : 'Auth event'

    await client.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `[GrantFlow] ${title}: ${ok ? 'OK' : 'FAIL'} (${safeIdentifier})`,
      html: `
        <h2>GrantFlow auth event</h2>
        <p><strong>Type:</strong> ${escapeHtml(title)}</p>
        <p><strong>Event:</strong> ${escapeHtml(safeEvent)}</p>
        <p><strong>Identifier:</strong> ${escapeHtml(safeIdentifier)}</p>
        <p><strong>Result:</strong> ${ok ? 'OK' : 'FAIL'}</p>
        ${safeError ? `<p><strong>Error:</strong> ${escapeHtml(safeError)}</p>` : ''}
        ${
          safeCtx
            ? `
          <hr />
          <p><strong>Context</strong></p>
          <ul>
            ${safeCtx.method ? `<li><strong>method:</strong> ${escapeHtml(safeCtx.method)}</li>` : ''}
            ${safeCtx.user_id ? `<li><strong>user_id:</strong> ${escapeHtml(safeCtx.user_id)}</li>` : ''}
            ${safeCtx.profile_id ? `<li><strong>profile_id:</strong> ${escapeHtml(safeCtx.profile_id)}</li>` : ''}
            ${safeCtx.ip ? `<li><strong>ip:</strong> ${escapeHtml(safeCtx.ip)}</li>` : ''}
            ${safeCtx.user_agent ? `<li><strong>user_agent:</strong> ${escapeHtml(safeCtx.user_agent)}</li>` : ''}
          </ul>
        `
            : ''
        }
        <p style="color:#64748b;font-size:12px;">This message is an automated operational alert. It never includes login codes.</p>
      `,
    })
    return true
  } catch (err) {
    console.error('[email] Failed to send auth attempt notification:', err?.message || err)
    return false
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Send a service application submission email
 * @param {string} toEmail - Recipient email address
 * @param {Object} applicationData - Service application data to format and send
 * @returns {Promise<boolean>} True if email was sent successfully
 * @throws {Error} If email service is not configured or sending fails
 */
export async function sendServiceApplicationEmail(toEmail, applicationData) {
  if (!toEmail || typeof toEmail !== 'string') {
    throw new Error('Invalid email address')
  }
  
  if (!applicationData || typeof applicationData !== 'object') {
    throw new Error('Invalid application data')
  }
  
  const client = await getResendClient()
  
  if (!client) {
    const errorMsg = 'Email service not configured. RESEND_API_KEY is missing from environment variables.'
    console.error('[email]', errorMsg, 'Would send service application to:', toEmail)
    throw new Error(errorMsg)
  }

  try {
    // Format service application data as HTML
    const htmlContent = formatServiceApplicationAsHTML(applicationData)
    
    await client.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `New Service Application - ${applicationData.fullName}`,
      html: htmlContent,
    })
    console.info('[email] Service application email sent successfully to', toEmail)
    return true
  } catch (error) {
    console.error('[email] Failed to send service application:', error?.message || error)
    throw new Error(`Failed to send service application email: ${error?.message || 'Unknown error'}`)
  }
}

function formatServiceApplicationAsHTML(data) {
  const categoryLabels = {
    individual: 'Individual',
    small: 'Small Organization',
    midSize: 'Mid-Size Organization',
    large: 'Large Organization',
  }

  const sections = []
  
  // Client Information
  sections.push(`
    <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px; margin-top: 0;">Client Information</h2>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr><td style="padding: 8px; font-weight: bold; width: 200px;">Full Name:</td><td style="padding: 8px;">${data.fullName}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Email:</td><td style="padding: 8px;">${data.email}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Phone:</td><td style="padding: 8px;">${data.phone || 'Not provided'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Organization:</td><td style="padding: 8px;">${data.organization || 'Not provided'}</td></tr>
      <tr><td style="padding: 8px; font-weight: bold;">Title/Position:</td><td style="padding: 8px;">${data.title || 'Not provided'}</td></tr>
    </table>
  `)

  // Client Category
  sections.push(`
    <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">Client Category</h2>
    <p style="font-size: 16px; margin: 10px 0 20px 0;"><strong>${categoryLabels[data.clientCategory] || data.clientCategory}</strong></p>
  `)

  // Selected Services
  if (data.selectedServices && data.selectedServices.length > 0) {
    const servicesHtml = data.selectedServices
      .map(service => `<li style="margin: 8px 0; font-size: 15px;">${service}</li>`)
      .join('')
    
    sections.push(`
      <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">Selected Services</h2>
      <ul style="margin: 10px 0 20px 0; padding-left: 20px;">
        ${servicesHtml}
      </ul>
    `)
  }

  // Total Cost
  sections.push(`
    <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">Estimated Total Cost</h2>
    <p style="font-size: 24px; font-weight: bold; color: #2563eb; margin: 10px 0 20px 0;">
      $${typeof data.totalCost === 'number' ? data.totalCost.toFixed(2) : '0.00'}
    </p>
  `)

  // Submission timestamp
  const submittedDate = data.submittedAt ? new Date(data.submittedAt).toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'long',
  }) : 'N/A'

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; 
          line-height: 1.6; 
          color: #333; 
          max-width: 800px; 
          margin: 0 auto; 
          padding: 20px;
          background-color: #f8fafc;
        }
        .container {
          background-color: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1 style="color: #1e40af; border-bottom: 3px solid #2563eb; padding-bottom: 10px; margin-top: 0;">
          New Service Application
        </h1>
        <p style="color: #666; margin-bottom: 30px; font-size: 14px;">
          Submitted on ${submittedDate}
        </p>
        ${sections.join('\n')}
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e2e8f0;">
        <div style="background-color: #f1f5f9; padding: 15px; border-radius: 6px; margin-top: 20px;">
          <p style="color: #475569; font-size: 13px; margin: 0;">
            <strong>Payment Terms:</strong><br>
            • 40% due at project kickoff<br>
            • 40% due at complete draft delivery<br>
            • 20% due at submission and handoff package delivery<br>
            • Net 15 days from invoice date
          </p>
        </div>
        <p style="color: #666; font-size: 12px; text-align: center; margin-top: 30px;">
          This application was submitted through GrantFlow Service Application Portal<br>
          Dr. John White, PhD, MBA | Grant Writing Consultant<br>
          Cell: 423.504.7778 | Fax: 423.414.5290
        </p>
      </div>
    </body>
    </html>
  `
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
  
  const client = await getResendClient()
  
  if (!client) {
    const errorMsg = 'Email service not configured. RESEND_API_KEY is missing from environment variables.'
    console.error('[email]', errorMsg, 'Would send application to:', toEmail)
    throw new Error(errorMsg)
  }

  try {
    // Format application data as HTML
    const htmlContent = formatApplicationAsHTML(applicationData)
    
    await client.emails.send({
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
