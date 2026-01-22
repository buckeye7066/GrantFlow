/**
 * Email service using Resend API
 * Runs on Railway backend (NOT Vercel frontend)
 * 
 * Required environment variables (set in Railway):
 * - RESEND_API_KEY: API key from resend.com
 * - FROM_EMAIL or EMAIL_FROM: Sender email address (must be verified domain in Resend)
 * 
 * Optional:
 * - AUTH_ALLOW_ADMIN_PREVIEW_CODE: Set to "true" to enable admin preview codes on email failure
 */

import { Resend } from 'resend'

// Resolve FROM address with fallback chain
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'noreply@grantflow.app'

/**
 * Check if email service is properly configured
 * @returns {boolean}
 */
export function isEmailServiceConfigured() {
  const hasApiKey = Boolean(process.env.RESEND_API_KEY)
  const hasFromEmail = Boolean(process.env.FROM_EMAIL || process.env.EMAIL_FROM)
  return hasApiKey && hasFromEmail
}

/**
 * Get or create Resend client instance
 * @returns {Resend|null}
 */
function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY
  
  if (!apiKey) {
    console.error('[email] RESEND_API_KEY not configured (provider: resend, runtime: railway)')
    return null
  }
  
  try {
    return new Resend(apiKey)
  } catch (error) {
    console.error('[email] Failed to initialize Resend client:', error.message, '(provider: resend, runtime: railway)')
    return null
  }
}

/**
 * Send verification email with 6-digit OTP code
 * @param {string} email - Recipient email address
 * @param {string} code - 6-digit verification code
 * @returns {Promise<boolean>} true if sent successfully, false otherwise
 */
export async function sendVerificationEmail(email, code) {
  const resend = getResendClient()
  
  if (!resend) {
    console.warn('[email/sendVerificationEmail] Resend not configured - email not sent (provider: resend, runtime: railway)')
    return false
  }
  
  const fromAddress = FROM_EMAIL
  
  console.info('[email/sendVerificationEmail] Attempting to send verification email', {
    to: email,
    from: fromAddress,
    provider: 'resend',
    runtime: 'railway',
    codeLength: code?.length || 0
  })
  
  try {
    const result = await resend.emails.send({
      from: fromAddress,
      to: email,
      subject: 'Your GrantFlow Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>GrantFlow Login Verification</h2>
          <p>Your verification code is:</p>
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">
            ${code}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this code, you can safely ignore this email.</p>
        </div>
      `,
      text: `Your GrantFlow verification code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, you can safely ignore this email.`
    })
    
    if (result.error) {
      console.error('[email/sendVerificationEmail] Resend API error:', {
        error: result.error,
        to: email,
        provider: 'resend',
        runtime: 'railway'
      })
      return false
    }
    
    console.info('[email/sendVerificationEmail] Email sent successfully', {
      id: result.data?.id,
      to: email,
      provider: 'resend',
      runtime: 'railway'
    })
    
    return true
  } catch (error) {
    console.error('[email/sendVerificationEmail] Failed to send email:', {
      error: error.message,
      stack: error.stack,
      to: email,
      provider: 'resend',
      runtime: 'railway'
    })
    
    // Propagate error for caller to handle
    throw new Error(`Email delivery failed: ${error.message}`)
  }
}

/**
 * Send notification about authentication attempt
 * Used for admin monitoring/alerting
 * @param {Object} params - Notification parameters
 * @param {string} params.event - Event type (email_start, email_verify, etc)
 * @param {string} params.identifier - User identifier (email/phone)
 * @param {boolean} params.success - Whether the attempt succeeded
 * @param {string|null} params.error - Error message if failed
 * @returns {Promise<boolean>}
 */
export async function sendAuthAttemptNotification({ event, identifier, success, error }) {
  // Only send notifications if explicitly enabled and admin email is configured
  const shouldNotify = process.env.AUTH_NOTIFY_ON_LOGIN === 'true'
  const notifyEmail = process.env.AUTH_NOTIFY_EMAIL || process.env.ADMIN_EMAIL
  
  if (!shouldNotify || !notifyEmail) {
    return false
  }
  
  const resend = getResendClient()
  if (!resend) {
    return false
  }
  
  try {
    const statusEmoji = success ? '✅' : '❌'
    const subject = `${statusEmoji} Auth Event: ${event}`
    
    await resend.emails.send({
      from: FROM_EMAIL,
      to: notifyEmail,
      subject,
      html: `
        <div style="font-family: monospace;">
          <h3>Authentication Event</h3>
          <ul>
            <li><strong>Event:</strong> ${event}</li>
            <li><strong>Identifier:</strong> ${identifier}</li>
            <li><strong>Success:</strong> ${success}</li>
            ${error ? `<li><strong>Error:</strong> ${error}</li>` : ''}
            <li><strong>Time:</strong> ${new Date().toISOString()}</li>
          </ul>
        </div>
      `,
      text: `Auth Event: ${event}\nIdentifier: ${identifier}\nSuccess: ${success}${error ? `\nError: ${error}` : ''}\nTime: ${new Date().toISOString()}`
    })
    
    return true
  } catch (error) {
    console.warn('[email/sendAuthAttemptNotification] Failed to send notification:', error.message)
    return false
  }
}

/**
 * Send application submission email
 * @param {string} toEmail - Recipient email
 * @param {Object} applicationData - Application details
 * @returns {Promise<boolean>}
 */
export async function sendApplicationEmail(toEmail, applicationData) {
  const resend = getResendClient()
  
  if (!resend) {
    const errorMsg = 'Email service not available. Cannot send application email without Resend configuration.'
    console.error('[email/sendApplicationEmail]', errorMsg, '(provider: resend, runtime: railway)')
    throw new Error(errorMsg)
  }
  
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: 'GrantFlow Application Submitted',
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Application Submitted Successfully</h2>
          <p>Your application has been received.</p>
          <pre>${JSON.stringify(applicationData, null, 2)}</pre>
        </div>
      `,
      text: `Your GrantFlow application has been submitted.\n\n${JSON.stringify(applicationData, null, 2)}`
    })
    
    console.info('[email/sendApplicationEmail] Application email sent', {
      to: toEmail,
      provider: 'resend',
      runtime: 'railway'
    })
    
    return true
  } catch (error) {
    console.error('[email/sendApplicationEmail] Failed to send:', {
      error: error.message,
      to: toEmail,
      provider: 'resend',
      runtime: 'railway'
    })
    throw new Error(`Failed to send application email: ${error.message}`)
  }
}
