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

export async function downloadAuthenticatedUrl(url, { fallbackFileName } = {}) {
  const endpoint = String(url || '').trim()
  if (!endpoint) throw new Error('Missing download URL')

  // Only needed for protected same-origin API endpoints.
  if (!endpoint.startsWith('/api/')) {
    window.open(endpoint, '_blank', 'noopener,noreferrer')
    return
  }

  const resp = await apiFetch(endpoint, { method: 'GET', responseType: 'response' })
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
  const endpoint = String(url || '').trim()
  if (!endpoint) throw new Error('Missing print URL')

  if (!endpoint.startsWith('/api/')) {
    const printWindow = window.open(endpoint, '_blank', 'noopener,noreferrer')
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

  const resp = await apiFetch(endpoint, { method: 'GET', responseType: 'blob' })
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

