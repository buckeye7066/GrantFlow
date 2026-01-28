import { apiFetch } from '@/api/apiClient'

function parseContentDispositionFilename(headerValue) {
  const raw = String(headerValue || '').trim()
  if (!raw) return null

  // RFC 5987: filename*=UTF-8''...
  const star = raw.match(/filename\*\s*=\s*([^;]+)/i)
  if (star) {
    const v = star[1].trim().replace(/^"(.*)"$/, '$1')
    const parts = v.split("''")
    if (parts.length === 2) {
      try {
        return decodeURIComponent(parts[1])
      } catch {
        return parts[1]
      }
    }
  }

  const simple = raw.match(/filename\s*=\s*([^;]+)/i)
  if (simple) {
    return simple[1].trim().replace(/^"(.*)"$/, '$1')
  }

  return null
}

/**
 * Normalize API path to handle various URL formats including base path routing.
 * Examples:
 *   normalizeAuthenticatedApiPath("api/x") -> "/api/x"
 *   normalizeAuthenticatedApiPath("/grantflow/api/x?y=1") -> "/api/x?y=1"
 *   normalizeAuthenticatedApiPath("https://host/grantflow/api/x") -> "/api/x"
 *   normalizeAuthenticatedApiPath("https://external.com/file") -> null (not an API path)
 */
export function normalizeAuthenticatedApiPath(url) {
  if (!url) return null
  const urlStr = String(url).trim()
  if (!urlStr) return null

  try {
    // Handle absolute URLs
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
      const parsed = new URL(urlStr)
      // Only normalize if it's our API
      if (parsed.pathname.includes('/api/')) {
        // Extract everything from /api/ onward
        const apiIndex = parsed.pathname.indexOf('/api/')
        if (apiIndex >= 0) {
          const normalizedPath = parsed.pathname.substring(apiIndex)
          return normalizedPath + parsed.search
        }
      }
      // External URL - return null to signal non-API
      return null
    }

    // Handle relative URLs
    // Remove leading slash for consistent processing
    let path = urlStr.startsWith('/') ? urlStr.substring(1) : urlStr
    
    // If it starts with api/ (no leading slash), add the slash
    if (path.startsWith('api/')) {
      return '/' + path
    }
    
    // If it contains base path like "grantflow/api/", extract from "/api/" onward
    if (path.includes('/api/')) {
      const apiIndex = path.indexOf('/api/')
      if (apiIndex >= 0) {
        return path.substring(apiIndex)
      }
    }
    
    // If it already starts with /api/, return as-is
    if (urlStr.startsWith('/api/')) {
      return urlStr
    }
    
    // Not an API path
    return null
  } catch {
    // Invalid URL format
    return null
  }
}

export async function downloadAuthenticatedUrl(url, { fallbackFileName } = {}) {
  const urlStr = String(url || '').trim()
  if (!urlStr) throw new Error('Missing download URL')

  // Normalize API paths to handle base path routing
  const normalizedApiPath = normalizeAuthenticatedApiPath(urlStr)
  
  // If not an API path, open externally without auth
  if (!normalizedApiPath) {
    window.open(urlStr, '_blank', 'noopener,noreferrer')
    return
  }

  // Use authenticated fetch for API endpoints
  const resp = await apiFetch(normalizedApiPath, { method: 'GET', responseType: 'response' })
  const disposition = resp.headers.get('content-disposition') || ''
  const nameFromHeader = parseContentDispositionFilename(disposition)
  const fileName = String(nameFromHeader || fallbackFileName || 'download').trim() || 'download'

  const blob = await resp.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = objectUrl
  link.download = fileName
  window.document.body.appendChild(link)
  link.click()
  window.document.body.removeChild(link)
  URL.revokeObjectURL(objectUrl)
}

export async function openAuthenticatedUrlForPrint(url) {
  const urlStr = String(url || '').trim()
  if (!urlStr) throw new Error('Missing print URL')

  // Normalize API paths to handle base path routing
  const normalizedApiPath = normalizeAuthenticatedApiPath(urlStr)
  
  // If not an API path, open externally without auth
  if (!normalizedApiPath) {
    const printWindow = window.open(urlStr, '_blank', 'noopener,noreferrer')
    if (printWindow) {
      printWindow.onload = () => {
        try {
          printWindow.print()
        } catch {
          // ignore
        }
      }
    }
    return
  }

  // Use authenticated fetch for API endpoints
  const resp = await apiFetch(normalizedApiPath, { method: 'GET', responseType: 'blob' })
  const objectUrl = URL.createObjectURL(resp)
  const printWindow = window.open(objectUrl, '_blank', 'noopener,noreferrer')
  if (printWindow) {
    printWindow.onload = () => {
      try {
        printWindow.print()
      } catch {
        // ignore
      }
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        // ignore
      }
    }
  } else {
    try {
      URL.revokeObjectURL(objectUrl)
    } catch {
      // ignore
    }
  }
}

