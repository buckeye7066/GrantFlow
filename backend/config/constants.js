/**
 * Shared Constants
 * 
 * Centralized constants used across the backend application
 */

// Admin Configuration
export const ADMIN_EMAIL = 'buckeye7066@gmail.com'

/**
 * Check if an email belongs to an admin user
 * @param {string} email - Email address to check
 * @returns {boolean} True if the email is an admin email
 */
export function isAdminEmail(email) {
  if (!email || typeof email !== 'string') {
    return false
  }
  return email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase()
}
