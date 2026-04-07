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
 * Build an absolute URL (with basename) for use outside React Router
 * (e.g. window.location.href). React Router's <Link> and navigate()
 * prepend the basename automatically — use createPageUrl for those.
 */
export function createAbsolutePageUrl(pageName, params) {
  const base = (import.meta.env.VITE_APP_BASE || import.meta.env.BASE_URL || '').replace(/\/$/, '')
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
