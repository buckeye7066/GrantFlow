import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isLoginMaintenanceActive } from '@/config/maintenance'

const REDIRECT_DELAY_MS = 1200

function parseParams(location) {
  const searchParams = new URLSearchParams(location.search || '')
  const hash = location.hash?.startsWith('#') ? location.hash.slice(1) : location.hash || ''
  const hashParams = new URLSearchParams(hash)

  hashParams.forEach((value, key) => {
    if (!searchParams.has(key)) {
      searchParams.set(key, value)
    }
  })

  return searchParams
}

function mapError(code) {
  switch (code) {
    case 'maintenance':
      return 'GrantFlow is being upgraded and sign-in is temporarily disabled. Please try again once the upgrade completes.'
    case 'oauth_state_invalid':
      return 'We could not validate the login request. Please start over.'
    case 'provider_not_configured':
      return 'This sign-in provider is not available right now. Try a different option.'
    case 'oauth_exchange_failed':
      return 'We were unable to complete the sign-in with that provider. Try again or use email/phone.'
    default:
      return 'Sign-in was cancelled or failed. Try again.'
  }
}

function formatProviderName(value) {
  if (!value) return 'provider'
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export default function AuthCallback() {
  const location = useLocation()
  const navigate = useNavigate()
  const completeOAuthSession = useAuthStore((state) => state.completeOAuthSession)
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState('Finishing your secure sign-in…')
  const timeoutRef = useRef(null)
  const handoffAttemptedRef = useRef(null)

  const params = useMemo(() => parseParams(location), [location])
  const provider = formatProviderName(params.get('provider'))
  const errorCode = params.get('error')

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    if (isLoginMaintenanceActive()) {
      setStatus('error')
      setMessage(
        'GrantFlow is being upgraded and sign-in is temporarily disabled. Please try again once the upgrade completes.',
      )
      return
    }

    if (errorCode) {
      setStatus('error')
      setMessage(mapError(errorCode))
      return
    }

    const handoff = params.get('handoff')

    if (!handoff) {
      setStatus('error')
      setMessage('Missing or expired sign-in handoff. Please try again.')
      return
    }
    if (handoffAttemptedRef.current === handoff) return
    handoffAttemptedRef.current = handoff

    // Clean URL to avoid leaving credentials in history
    if (typeof window !== 'undefined') {
      const cleanUrl = `${window.location.pathname}`
      window.history.replaceState({}, document.title, cleanUrl)
    }

    completeOAuthSession(handoff)
      .then((result) => {
        if (!result || typeof result !== 'object' || result.error || !result.user) {
          throw new Error('AUTHENTICATION_FAILED')
        }
        setStatus('success')
        setMessage('Success! Redirecting you to your workspace…')
        timeoutRef.current = setTimeout(() => {
          navigate('/Dashboard', { replace: true })
        }, REDIRECT_DELAY_MS)
      })
      .catch(() => {
        setStatus('error')
        setMessage('We could not complete the sign-in. Try again or switch to email/SMS.')
      })
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [errorCode, params, completeOAuthSession, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-lg">
        <div className="flex flex-col items-center gap-4 text-center">
          {status === 'loading' ? <Loader2 className="h-10 w-10 animate-spin text-blue-600" /> : null}
          {status === 'success' ? <CheckCircle2 className="h-10 w-10 text-emerald-500" /> : null}
          {status === 'error' ? <AlertCircle className="h-10 w-10 text-rose-500" /> : null}

          <div>
            <p className="text-sm uppercase tracking-wide text-slate-500">Signing in with {provider}</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">
              {status === 'success' ? 'You’re in!' : status === 'error' ? 'Sign-in issue' : 'Verifying credentials'}
            </h1>
          </div>

          <p className="text-sm text-slate-600">{message}</p>

          {status === 'error' ? (
            <div className="flex w-full flex-col gap-3">
              <Button onClick={() => navigate('/login', { replace: true })}>Return to login</Button>
              <Button variant="outline" onClick={() => navigate(-1)}>
                Try provider again
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
