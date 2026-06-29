import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, MailCheck, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { checkAccess } from '@/api/auth'

function normalizeEmail(value) {
  if (value === null) return ''
  return String(value).trim().toLowerCase()
}

const emailSchema = z.object({
  email: z.preprocess((v) => normalizeEmail(v), z.string().email('Enter a valid email or phone number')),
})

/** True when the entered identifier is an email (not a phone number). */
export function looksLikeEmail(value) {
  return typeof value === 'string' && value.includes('@')
}

/**
 * Normalize a phone number to E.164 on the CLIENT before sending, so the
 * backend receives a fully-qualified number (e.g. a bare US 10-digit becomes
 * +1XXXXXXXXXX). Mirrors backend/services/sms.js normalizePhone. Returns null
 * when the value can't be a phone number.
 */
export function normalizePhoneE164(raw) {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '')
    return digits.length >= 8 ? `+${digits}` : null
  }
  const digits = s.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8) return `+${digits}`
  return null
}

export default function EmailSignInForm({ onComplete }) {
  const [step, setStep] = useState('email') // email | password | setup_sent | phone_code
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [resetRequested, setResetRequested] = useState(false)
  const [status, setStatus] = useState({ type: 'idle', message: null, previewCode: null, notice: null, channel: 'email' })
  const [isLoading, setIsLoading] = useState(false)
  const [emailError, setEmailError] = useState(null)
  const [codeError, setCodeError] = useState(null)
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

  const maskedPhone = useMemo(() => {
    if (!phone) return null
    const last4 = phone.slice(-4)
    return `${phone.slice(0, Math.max(0, phone.length - 4)).replace(/\d/g, '•')}${last4}`
  }, [phone])

  const handleSendCode = async (event) => {
    event?.preventDefault?.()
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })

      // Read from FormData so the form works even when synthetic typing doesn't trigger React change events.
      const form = event?.currentTarget
      const rawIdentifier = form ? new FormData(form).get('email') : null
      const rawValue = String(rawIdentifier ?? '').trim()

      // Phone path: if the identifier isn't an email, try to treat it as a phone
      // number and send an SMS one-time code (no password / access gate — the
      // backend phone/start provisions the credential and texts the code).
      if (!looksLikeEmail(rawValue)) {
        const e164 = normalizePhoneE164(rawValue)
        if (!e164) {
          setEmailError('Enter a valid email or phone number')
          return
        }
        setEmailError(null)
        await authStore.startPhoneSignIn(e164)
        setPhone(e164)
        setCode('')
        setCodeError(null)
        setStep('phone_code')
        setStatus({
          type: 'success',
          channel: 'phone',
          message: `We texted a 6-digit code to ${e164.slice(0, Math.max(0, e164.length - 4)).replace(/\d/g, '•')}${e164.slice(-4)}. Enter it below to sign in.`,
          previewCode: null,
          notice: 'The code expires in a few minutes. Standard message and data rates may apply.',
        })
        return
      }

      const parsed = emailSchema.safeParse({ email: rawValue })
      if (!parsed.success) {
        setEmailError(parsed.error.issues?.[0]?.message || 'Enter a valid email or phone number')
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

  const handlePhoneVerify = async (event) => {
    event?.preventDefault?.()
    try {
      setIsLoading(true)
      setCodeError(null)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null, channel: 'phone' })

      const form = event?.currentTarget
      const rawCode = form ? new FormData(form).get('code') : code
      const cleaned = String(rawCode ?? '').replace(/\D/g, '').slice(0, 6)
      if (cleaned.length !== 6) {
        setCodeError('Enter the 6-digit code we texted you')
        return
      }

      const response = await authStore.verifyPhoneCode({ phone, code: cleaned })
      if (typeof onComplete === 'function') {
        onComplete(response)
      }
      setStatus({ type: 'success', channel: 'phone', message: 'Success! Redirecting you to the dashboard…', previewCode: null, notice: null })
    } catch (error) {
      const message = error?.error || error?.message || 'Unable to verify code. Please try again.'
      setStatus({ type: 'error', channel: 'phone', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
    }
  }

  const handleResendPhoneCode = async () => {
    try {
      setIsLoading(true)
      await authStore.startPhoneSignIn(phone)
      setStatus({
        type: 'success',
        channel: 'phone',
        message: `We sent a new code to ${maskedPhone}.`,
        previewCode: null,
        notice: 'If you still don’t receive it, check the number and try a different one.',
      })
    } catch (error) {
      const retry = error?.details?.retry_after_seconds ?? error?.retry_after_seconds
      const message = retry
        ? `Please wait ${retry}s before requesting another code.`
        : error?.error || error?.message || 'Unable to resend the code.'
      setStatus({ type: 'error', channel: 'phone', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
    }
  }

  const successTitle = status.channel === 'phone' ? 'Check your phone' : 'Check your email'

  return (
    <div className="space-y-6">
      {status.type !== 'idle' ? (
        <Alert variant={status.type === 'error' ? 'destructive' : 'default'}>
          {status.type === 'success' ? (
            status.channel === 'phone' ? <MessageSquare className="h-4 w-4" /> : <MailCheck className="h-4 w-4" />
          ) : null}
          <AlertTitle>{status.type === 'error' ? 'Something went wrong' : successTitle}</AlertTitle>
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
            <Label htmlFor="auth-email">Email or phone number</Label>
            <Input
              id="auth-email"
              name="email"
              type="text"
              inputMode="email"
              placeholder="jane@example.org or +1 555 123 4567"
              autoComplete="username"
              aria-invalid={emailError ? 'true' : 'false'}
            />
            {emailError ? <p className="text-xs text-red-600">{emailError}</p> : null}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue
          </Button>
          <p className="text-xs text-slate-500">
            Use your email (we’ll send a one-time link on first sign-in) or your phone number
            (we’ll text you a 6-digit code).
          </p>
        </form>
      ) : null}

      {step === 'phone_code' ? (
        <form onSubmit={handlePhoneVerify} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-phone-code">6-digit code</Label>
            <Input
              id="auth-phone-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-invalid={codeError ? 'true' : 'false'}
            />
            {codeError ? <p className="text-xs text-red-600">{codeError}</p> : null}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Verify &amp; sign in
          </Button>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setCodeError(null); setStatus({ type: 'idle', message: null, previewCode: null, notice: null, channel: 'email' }) }}
              className={cn('text-blue-600 hover:underline', isLoading && 'pointer-events-none opacity-60')}
            >
              Use a different email or phone
            </button>
            <button
              type="button"
              onClick={handleResendPhoneCode}
              className={cn('text-blue-600 hover:underline', isLoading && 'pointer-events-none opacity-60')}
            >
              Resend code
            </button>
          </div>
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
