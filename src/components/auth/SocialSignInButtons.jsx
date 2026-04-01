import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Facebook, Loader2, Globe, AlertCircle, RefreshCw } from 'lucide-react'
import { useState, useCallback } from 'react'

const PROVIDERS = [
  {
    id: 'google',
    label: 'Continue with Google',
    icon: Globe,
  },
  {
    id: 'facebook',
    label: 'Continue with Facebook',
    icon: Facebook,
  },
  {
    id: 'yahoo',
    label: 'Continue with Yahoo',
    icon: Globe,
  },
]

const APP_BASE = import.meta.env.VITE_APP_BASE ?? '/grantflow'
const MAX_RETRIES = 2
const RETRY_DELAY = 2000 // 2 seconds

function buildRedirectTo(appBase) {
  if (typeof window === 'undefined') return appBase
  const normalizedBase = appBase === '/' ? '' : appBase.replace(/\/$/, '')
  return `${window.location.origin}${normalizedBase}/auth/callback`
}

function buildAuthStartUrl(providerId, redirectTo) {
  const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
  const base = apiBase || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/api/auth/${providerId}/start?redirect_to=${encodeURIComponent(redirectTo)}`
}

/**
 * Check if backend is available by pinging the health endpoint
 */
async function checkBackendHealth() {
  try {
    const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
    const base = apiBase || (typeof window !== 'undefined' ? window.location.origin : '')
    const response = await fetch(`${base}/health`, { 
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5 second timeout
    })
    return response.ok
  } catch (error) {
    console.error('[SocialSignIn] Backend health check failed:', error)
    return false
  }
}

/**
 * Check authentication diagnostics
 */
async function checkAuthDiagnostics(providerId) {
  try {
    const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
    const base = apiBase || (typeof window !== 'undefined' ? window.location.origin : '')
    const response = await fetch(`${base}/api/auth/diagnostics`, { 
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const data = await response.json()
      console.info('[SocialSignIn] Auth diagnostics:', data)
      
      // Check if the specific provider is configured
      if (data.providers && data.providers[providerId]) {
        return {
          configured: data.providers[providerId].configured,
          details: data.providers[providerId]
        }
      }
    }
    return { configured: false }
  } catch (error) {
    console.error('[SocialSignIn] Diagnostics check failed:', error)
    return { configured: false }
  }
}

export default function SocialSignInButtons({ onComplete: _onComplete }) {
  const [activeProvider, setActiveProvider] = useState(null)
  const [error, setError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  const [isCheckingBackend, setIsCheckingBackend] = useState(false)

  const handleClick = useCallback(async (provider, retry = 0) => {
    setError(null)
    setActiveProvider(provider.id)
    
    try {
      console.info(`[SocialSignIn] Starting ${provider.id} authentication (attempt ${retry + 1}/${MAX_RETRIES + 1})`)
      
      // First, check if backend is available
      if (retry === 0) {
        setIsCheckingBackend(true)
        const backendHealthy = await checkBackendHealth()
        setIsCheckingBackend(false)
        
        if (!backendHealthy) {
          throw new Error('Backend server is not responding. Please ensure the server is running and try again.')
        }
        
        // Check if provider is configured
        const diagnostics = await checkAuthDiagnostics(provider.id)
        if (!diagnostics.configured) {
          throw new Error(`${provider.label} is not configured on the server. Please contact your administrator to set up OAuth credentials.`)
        }
      }
      
      const redirectTo = buildRedirectTo(APP_BASE)
      const startUrl = buildAuthStartUrl(provider.id, redirectTo)

      // Guard: only navigate to same-origin or explicitly trusted API origin
      const allowedOrigins = [
        window.location.origin,
        (import.meta.env.VITE_API_URL || '').replace(/\/$/, ''),
      ].filter(Boolean)
      const parsedStart = new URL(startUrl)
      if (!allowedOrigins.includes(parsedStart.origin)) {
        throw new Error(`Untrusted redirect origin: ${parsedStart.origin}`)
      }

      console.info(`[SocialSignIn] Redirecting to: ${startUrl}`)
      window.location.href = startUrl
    } catch (err) {
      console.error(`[SocialSignIn] Failed to start ${provider.id} login:`, err)
      
      // Check if this is a retriable error
      const isRetriable = err.message.includes('fetch') || 
                          err.message.includes('Network') || 
                          err.message.includes('timeout')
      
      if (isRetriable && retry < MAX_RETRIES) {
        setError(`Connection failed. Retrying... (${retry + 1}/${MAX_RETRIES})`)
        setRetryCount(retry + 1)

        // Capture the provider id at schedule time; if user clicks away the
        // retry will find activeProvider no longer matches and bail out.
        const scheduledProviderId = provider.id
        setTimeout(() => {
          // Abort stale retry if user cancelled or switched provider
          setActiveProvider((current) => {
            if (current !== scheduledProviderId) return current // already cancelled
            return current
          })
          // Use functional read to decide whether to proceed
          handleClick(provider, retry + 1)
        }, RETRY_DELAY)
        return // prevent fall-through
      } else {
        // Show final error
        setError(getErrorMessage(err))
        setActiveProvider(null)
        setRetryCount(0)
      }
    }
  }, [])

  const getErrorMessage = (err) => {
    const message = err.message || err.toString()
    
    // Check for specific error patterns
    if (message.includes('Backend server is not responding')) {
      return (
        <div className="space-y-2">
          <p className="font-semibold">Backend Server Unavailable</p>
          <p>The authentication server is not responding. Please:</p>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li>Ensure the backend server is running</li>
            <li>Check your network connection</li>
            <li>Verify the API URL configuration</li>
          </ul>
        </div>
      )
    }
    
    if (message.includes('not configured')) {
      return (
        <div className="space-y-2">
          <p className="font-semibold">Provider Not Configured</p>
          <p>{message}</p>
        </div>
      )
    }
    
    if (message.includes('502') || message.includes('Bad Gateway')) {
      return (
        <div className="space-y-2">
          <p className="font-semibold">Server Error (502)</p>
          <p>The authentication server returned an error. Please try again or contact support.</p>
        </div>
      )
    }
    
    // Default error
    return `Unable to launch the provider sign-in: ${message}`
  }

  const handleRetry = () => {
    setError(null)
    setRetryCount(0)
    setActiveProvider(null)
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Prefer single sign-on? Connect with Google, Facebook, or Yahoo. We'll route you back here once your provider
        verifies your identity.
      </p>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 space-y-2">
              <div className="text-sm text-rose-900">
                {error}
              </div>
              {!activeProvider && (
                <Button
                  onClick={handleRetry}
                  variant="outline"
                  size="sm"
                  className="mt-2"
                >
                  <RefreshCw className="h-3 w-3 mr-2" />
                  Try Again
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {PROVIDERS.map((provider) => {
        const Icon = provider.icon
        const isLoading = activeProvider === provider.id
        const isDisabled = (activeProvider && activeProvider !== provider.id) || isCheckingBackend
        
        return (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            className={cn('w-full justify-start gap-2', isLoading && 'opacity-80')}
            onClick={() => handleClick(provider)}
            disabled={isDisabled || isLoading}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Icon className="h-4 w-4" />
            )}
            <span>{provider.label}</span>
            {isLoading && (
              <span className="ml-auto text-xs uppercase tracking-wide text-slate-400">
                {isCheckingBackend ? 'checking...' : `redirecting${retryCount > 0 ? ` (${retryCount}/${MAX_RETRIES})` : '…'}`}
              </span>
            )}
          </Button>
        )
      })}
    </div>
  )
}
