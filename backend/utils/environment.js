/**
 * Environment detection utilities
 * Centralized logic for determining production vs development environments
 */

/**
 * Check if the current environment is production
 * @returns {boolean} True if running in production environment
 */
export function isProductionEnvironment() {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT === 'production' ||
    process.env.VERCEL_ENV === 'production'
  )
}

/**
 * Get environment name for logging
 * @returns {string} Environment name
 */
export function getEnvironmentName() {
  if (process.env.RAILWAY_ENVIRONMENT) return process.env.RAILWAY_ENVIRONMENT
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV
  return process.env.NODE_ENV || 'development'
}
