/**
 * Fallback email service when Resend is not available
 * This is only for local development to allow auth flow testing without email configuration
 * 
 * WARNING: This fallback should NEVER be used in production environments.
 * Production environments MUST have RESEND_API_KEY and FROM_EMAIL configured.
 */

import { isProductionEnvironment, getEnvironmentName } from '../utils/environment.js'
import { EmailNotConfiguredError } from './email.js'

/**
 * Check if email service is configured
 * @returns {boolean} Always returns false for fallback
 */
export function isEmailServiceConfigured() {
  return false
}

/**
 * Fallback verification email sender (DEV ONLY)
 * @param {string} email - Recipient email address
 * @param {string} code - 6-digit verification code
 * @returns {Promise<boolean>} Always returns false to indicate email wasn't sent
 */
export async function sendVerificationEmail(email, code) {
  const isProd = isProductionEnvironment()

  console.warn('[emailFallback/sendVerificationEmail] Using fallback email service - email NOT sent')
  console.warn('[emailFallback] Target email:', email)
  console.warn('[emailFallback] Environment:', {
    environment: getEnvironmentName(),
    isProd,
  })

  if (isProd) {
    const errorMsg = 'Email service not configured. Fallback service cannot be used in production. Configure RESEND_API_KEY and FROM_EMAIL in Railway.'
    console.error('[emailFallback/sendVerificationEmail]', errorMsg)
    throw new EmailNotConfiguredError(errorMsg)
  }

  // Always return false to indicate email wasn't actually sent
  // This ensures the preview code is shown in the UI
  return false
}

export async function sendPasswordSetupEmail(email, link) {
  const isProd = isProductionEnvironment()

  console.warn('[emailFallback/sendPasswordSetupEmail] Using fallback email service - email NOT sent')
  console.warn('[emailFallback] Target email:', email)
  console.warn('[emailFallback] Password setup link:', link)
  console.warn('[emailFallback] Environment:', {
    environment: getEnvironmentName(),
    isProd,
  })

  if (isProd) {
    const errorMsg = 'Email service not configured. Fallback service cannot be used in production. Configure RESEND_API_KEY and FROM_EMAIL in Railway.'
    console.error('[emailFallback/sendPasswordSetupEmail]', errorMsg)
    throw new EmailNotConfiguredError(errorMsg)
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