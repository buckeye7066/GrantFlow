import { env } from '@/config/env.js'

export function createPageUrl(pageName, params) {
  const basePath = `/${pageName.replace(/\s+/g, '')}`

  if (!params) {
    return basePath
  }

  const searchParams = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    searchParams.set(key, String(value))
  })

  const queryString = searchParams.toString()
  return queryString ? `${basePath}?${queryString}` : basePath
}

/**
 * Like createPageUrl, but prepends the app basename (VITE_APP_BASE).
 * Use this when setting window.location.href directly — React Router's
 * <Link> and navigate() already prepend the basename automatically, so
 * createPageUrl (without the base) is correct for those APIs.
 */
export function createFullPageUrl(pageName, params) {
  const base = env.appBase && env.appBase !== '/' ? env.appBase : ''
  return `${base}${createPageUrl(pageName, params)}`
}

/**
 * Safely convert an address to a displayable string.
 * Handles both string addresses and object addresses with keys like
 * {street, city, state, zip_code, zip, line1, line2, postal_code}.
 */
export function formatAddress(address) {
  if (!address) return ''
  if (typeof address === 'string') return address
  if (typeof address === 'object') {
    const street = address.street || address.line1 || address.address1 || ''
    const city = address.city || ''
    const state = address.state || ''
    const zip = address.zip_code || address.zip || address.postal_code || address.postal || ''
    return [street, city, state, zip].filter(Boolean).join(', ')
  }
  return String(address)
}
