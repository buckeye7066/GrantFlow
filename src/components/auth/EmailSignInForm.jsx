import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, MailCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { checkAccess } from '@/api/auth'

function normalizeEmail(value) {
  if (value === null) return ''
  return String(value).trim().toLowerCase()
}

const emailSchema = z.object({
  email: z.preprocess((v) => normalizeEmail(v), z.string().email('Enter a valid email address')),
})

export default function EmailSignInForm({ onComplete }) {
  const [step, setStep] = useState('email') // email | password | setup_sent
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [resetRequested, setResetRequested] = useState(false)
  const [status, setStatus] = useState({ type: 'idle', message: null, previewCode: null, notice: null })
  const [isLoading, setIsLoading] = useState(false)
  const [emailError, setEmailError] = useState(null)
  const [passwordError, setPasswordError] = useState(null)
  const authStore = useAuthStore()
  const navigate = useNavigate()

  const maskedEmail = useMemo(() => {
    if (!email) return null
    const [user, domain] = email.split('@')
    if (!domain) return email
    const maskedUser =
      user.length <= 2 ? `${user[0] ?? ''}***` : `${user.slice(0, 2)}${'*'.repeat(Math.max(user.length - 2, 3))}`
    return `${maskedUser}@${domain}`
  }, [email])

  const handleSendCode = async (event) => {
    event?.preventDefault?.()
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })

      // Read from FormData so the form works even when synthetic typing doesn't trigger React change events.
      const form = event?.currentTarget
      const rawEmail = form ? new FormData(form).get('email') : null
      const parsed = emailSchema.safeParse({ email: rawEmail })
      if (!parsed.success) {
        setEmailError(parsed.error.issues?.[0]?.message || 'Enter a valid email address')
        return
      }

      setEmailError(null)
      const cleanedEmail = normalizeEmail(parsed.data.email)
      
      // Step 1: Check access BEFORE attempting password setup
      let accessCheck
      try {
        accessCheck = await checkAccess(cleanedEmail)
      } catch (error) {
        // If access check fails with 403, redirect to ServiceApplication
        if (error?.status === 403 || error?.details?.allowed === false) {
          navigate('/ServiceApplication')
          return
        }
        // For other errors, show generic message
        throw new Error('Unable to verify email access. Please try again.')
      }

      // If not allowed, redirect (shouldn't happen if 403 is caught above, but defensive)
      if (accessCheck?.allowed === false) {
        navigate(accessCheck?.redirect_to || '/ServiceApplication')
        return
      }

      // Step 2: Branch based on whether user has password
      setEmail(cleanedEmail)
      
      if (accessCheck?.hasPassword) {
        // User has password - prompt for it
        setPassword('')
        setPasswordError(null)
        setStep('password')
        setStatus({
          type: 'success',
          message: `Password found for ${maskedEmail ?? cleanedEmail}. Enter it below to sign in.`,
          previewCode: null,
          notice: null,
        })
        return
      }

      // User doesn't have password - send setup email
      const response = await authStore.startPasswordSetup(cleanedEmail)

      if (response?.status === 'password_setup_email_sent') {
        // Dev convenience: if the backend can't send email and provides a preview token, route straight to set-password.
        const smokeMode = String(import.meta?.env?.VITE_SMOKE_MODE || '').toLowerCase() === 'true'
        if (response?.preview_token && (import.meta?.env?.DEV || smokeMode)) {
          navigate(`/set-password?token=${encodeURIComponent(String(response.preview_token))}`)
          return
        }

        setStep('setup_sent')
        setStatus({
          type: 'success',
          message: `Check your email to set your password for ${maskedEmail ?? cleanedEmail}.`,
          previewCode: null,
          notice:
            response?.notice ??
            'If you don’t receive an email within a few minutes, check spam/junk and try again.',
        })
        return
      }

      setStatus({
        type: 'error',
        message: 'Unable to start sign-in. Please try again.',
        previewCode: null,
        notice: null,
      })
    } catch (error) {
      // Provide more specific error messages based on error type
      let message = 'Unable to send verification code.'

      if (error?.status === 503 || error?.errorType === 'email_not_configured' || error?.errorType === 'email_delivery_failed') {
        message = 'Email service is temporarily unavailable. Please contact support or try again later.'
      } else if (error?.message?.includes('not configured') || error?.message?.includes('RESEND_API_KEY')) {
        message = 'Email service is temporarily unavailable. Please contact support or try again later.'
      } else if (error?.message?.includes('network') || error?.message?.includes('fetch')) {
        message = 'Network error. Please check your internet connection and try again.'
      } else if (error?.message?.includes('rate limit')) {
        message = 'Too many attempts. Please wait a few minutes before trying again.'
      } else if (error?.error) {
        message = error.error
      } else if (error?.message) {
        message = error.message
      }

      setStatus({ type: 'error', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
    }
  }

  const handlePasswordLogin = async (event) => {
    event?.preventDefault?.()
    try {
      setIsLoading(true)
      setPasswordError(null)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })

      if (!password || String(password).trim().length < 10) {
        setPasswordError('Password must be at least 10 characters long')
        return
      }

      const response = await authStore.loginWithPassword({ email, password })
      if (typeof onComplete === 'function') {
        onComplete(response)
      }
      setStatus({
        type: 'success',
        message: 'Success! Redirecting you to the dashboard…',
        previewCode: null,
        notice: null,
      })
    } catch (error) {
      // Provide more specific error messages
      const message = error?.error || error?.message || 'Unable to sign in. Please try again.'
      setStatus({ type: 'error', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
    }
  }

  const handlePasswordReset = async () => {
    try {
      setIsLoading(true)
      setResetRequested(true)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })

      const response = await authStore.startPasswordReset(email)
      if (response?.status === 'password_reset_email_sent' || response?.status === 'password_setup_email_sent') {
        setStep('setup_sent')
        setStatus({
          type: 'success',
          message: `Check your email to reset your password for ${maskedEmail ?? email}.`,
          previewCode: null,
          notice:
            response?.notice ??
            'If you don’t receive an email within a few minutes, check spam/junk and try again.',
        })
        return
      }

      setStatus({
        type: 'error',
        message: 'Unable to send password reset email. Please try again.',
        previewCode: null,
        notice: null,
      })
    } catch (error) {
      const message = error?.error || error?.message || 'Unable to send password reset email. Please try again.'
      setStatus({ type: 'error', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
      setResetRequested(false)
    }
  }

  return (
    <div className="space-y-6">
      {status.type !== 'idle' ? (
        <Alert variant={status.type === 'error' ? 'destructive' : 'default'}>
          {status.type === 'success' ? <MailCheck className="h-4 w-4" /> : null}
          <AlertTitle>{status.type === 'error' ? 'Something went wrong' : 'Check your email'}</AlertTitle>
          <AlertDescription>
            {status.message}
            {status.notice ? (
              <p className="mt-2 text-xs text-slate-600">{status.notice}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {step === 'email' ? (
        <form onSubmit={handleSendCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-email">Profile email</Label>
            <Input
              id="auth-email"
              name="email"
              type="email"
              placeholder="jane@example.org"
              autoComplete="email"
              aria-invalid={emailError ? 'true' : 'false'}
            />
            {emailError ? <p className="text-xs text-red-600">{emailError}</p> : null}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue with Email
          </Button>
          <p className="text-xs text-slate-500">
            We'll email you a one-time link to set your password on first sign-in.
          </p>
        </form>
      ) : null}

      {step === 'password' ? (
        <form onSubmit={handlePasswordLogin} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              name="password"
              type="password"
              placeholder="Enter password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={passwordError ? 'true' : 'false'}
            />
            {passwordError ? <p className="text-xs text-red-600">{passwordError}</p> : null}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Sign in
          </Button>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <button
              type="button"
              onClick={() => setStep('email')}
              className={cn('text-blue-600 hover:underline', isLoading && 'pointer-events-none opacity-60')}
            >
              Use a different email
            </button>
            <button
              type="button"
              onClick={handlePasswordReset}
              className={cn('text-blue-600 hover:underline', (isLoading || resetRequested) && 'pointer-events-none opacity-60')}
            >
              Forgot password?
            </button>
          </div>
        </form>
      ) : null}

      {step === 'setup_sent' ? (
        <div className="space-y-4">
          <Button type="button" variant="outline" disabled={isLoading} onClick={() => setStep('email')} className="w-full">
            Use a different email
          </Button>
        </div>
      ) : null}
    </div>
  )
}
