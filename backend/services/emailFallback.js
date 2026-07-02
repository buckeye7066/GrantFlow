/**
 * Fallback email service when Resend is not available
 * This ensures the authentication flow continues even without email delivery
 */

/**
 * Check if email service is configured
 * @returns {boolean} Always returns false for fallback
 */
export function isEmailServiceConfigured() {
  return false
}

/**
 * Fallback verification email sender
 * @param {string} email - Recipient email address
 * @param {string} code - 6-digit verification code
 * @returns {Promise<boolean>} Always returns false to indicate email wasn't sent
 */
export async function sendVerificationEmail(email, code) {
  console.warn('[emailFallback] Using fallback email service')
  console.warn('[emailFallback] Email would be sent to:', email)
  
  // Always return false to indicate email wasn't actually sent
  // This ensures the preview code is shown in the UI
  return false
}

export async function sendPasswordSetupEmail(email, link) {
  console.warn('[emailFallback] Using fallback email service')
  console.warn('[emailFallback] Password setup email would be sent to:', email)
  if (process.env.NODE_ENV !== 'production') {
    // Dev convenience only — the link embeds the setup token, which must never
    // land in production logs (auth routes error out before this in prod, but
    // belt-and-braces).
    console.warn('[emailFallback] Password setup link:', link)
  }
  return false
}

/**
 * Fallback application email sender
 * @param {string} toEmail - Recipient email address
 * @param {Object} applicationData - Application data
 * @returns {Promise<boolean>} Throws error as this is not supported in fallback
 */
export async function sendApplicationEmail(toEmail, applicationData) {
  const errorMsg = 'Email service not available. Application emails cannot be sent without Resend package.'
  console.error('[emailFallback]', errorMsg)
  throw new Error(errorMsg)
}