import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Facebook, Loader2, Globe } from 'lucide-react'
import { useState } from 'react'

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

export default function SocialSignInButtons({ onComplete: _onComplete }) {
  const [activeProvider, setActiveProvider] = useState(null)
  const [error, setError] = useState(null)

  const handleClick = (provider) => {
    setError(null)
    setActiveProvider(provider.id)
    try {
      const redirectTo = buildRedirectTo(APP_BASE)
      const startUrl = buildAuthStartUrl(provider.id, redirectTo)
      window.location.href = startUrl
    } catch (err) {
      console.error('Failed to start social login', err)
      setError('Unable to launch the provider sign-in. Please try again.')
      setActiveProvider(null)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Prefer single sign-on? Connect with Google, Facebook, or Yahoo. We’ll route you back here once your provider
        verifies your identity.
      </p>

      {error ? <p className="text-xs text-rose-500">{error}</p> : null}

      {PROVIDERS.map((provider) => {
        const Icon = provider.icon
        const isLoading = activeProvider === provider.id
        return (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            className={cn('w-full justify-start gap-2', isLoading && 'opacity-80')}
            onClick={() => handleClick(provider)}
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
            <span>{provider.label}</span>
            {isLoading ? (
              <span className="ml-auto text-xs uppercase tracking-wide text-slate-400">redirecting…</span>
            ) : null}
          </Button>
        )
      })}
    </div>
  )
}
