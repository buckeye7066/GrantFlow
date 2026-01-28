import { useEffect, useState } from 'react'
import { apiFetch } from '@/api/apiClient'
import { normalizeAuthenticatedApiPath } from '@/utils/authenticatedDownload'

/**
 * Hook to fetch and display authenticated avatar images.
 * Converts protected API URLs to blob URLs that can be used in <img> tags.
 * 
 * @param {string|null} avatarUrl - The avatar URL (may be protected API endpoint or public URL)
 * @returns {string|null} - Object URL for the avatar, or the original URL if not a protected API endpoint
 */
export function useAuthenticatedAvatar(avatarUrl) {
  const [blobUrl, setBlobUrl] = useState(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!avatarUrl) {
      setBlobUrl(null)
      return
    }

    // Check if this is a protected API endpoint
    const normalizedApiPath = normalizeAuthenticatedApiPath(avatarUrl)
    
    // If not an API path, use the URL directly
    if (!normalizedApiPath) {
      setBlobUrl(avatarUrl)
      return
    }

    // Fetch the protected resource with authentication
    let cancelled = false
    let objectUrl = null

    setIsLoading(true)
    
    apiFetch(normalizedApiPath, { method: 'GET', responseType: 'blob' })
      .then(blob => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setBlobUrl(objectUrl)
        setIsLoading(false)
      })
      .catch(error => {
        if (cancelled) return
        console.error('[useAuthenticatedAvatar] Failed to fetch avatar:', error)
        // Fallback to original URL on error
        setBlobUrl(avatarUrl)
        setIsLoading(false)
      })

    // Cleanup function to revoke object URL
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [avatarUrl])

  return { blobUrl, isLoading }
}
