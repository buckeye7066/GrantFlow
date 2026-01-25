import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, MailCheck, RefreshCw, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'

function normalizeEmail(value) {
  if (value == null) return ''
  return String(value).trim().toLowerCase()
}

const emailSchema = z.object({
  email: z.preprocess((v) => normalizeEmail(v), z.string().email('Enter a valid email address')),
})

const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code we sent'),
})

export default function EmailSignInForm({ onComplete }) {
  const [step, setStep] = useState('email')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState({ type: 'idle', message: null, previewCode: null, notice: null })
  const [verificationToken, setVerificationToken] = useState(null)
  const [resendCountdown, setResendCountdown] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [emailError, setEmailError] = useState(null)
  const [codeError, setCodeError] = useState(null)
  const authStore = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (resendCountdown <= 0) return undefined
    const timer = setInterval(() => setResendCountdown((seconds) => seconds - 1), 1000)
    return () => clearInterval(timer)
  }, [resendCountdown])

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
      const response = await authStore.startEmailSignIn(cleanedEmail)
      setEmail(cleanedEmail)
      setVerificationToken(response?.verification_token ?? null)
      setStep('code')
      setResendCountdown(45)
      setCopyFeedback(null)
      const previewCode = response?.previewCode ?? null
      const emailSent = response?.email_sent === true
      const notice =
        response?.notice ??
        (previewCode
          ? 'Email delivery is not configured for this environment. Use the generated code below to continue.'
          : !emailSent
            ? 'Email delivery may be delayed. Check spam/junk and try again in a minute if you don’t receive a code.'
          : null)
      // Never log OTP codes in production consoles.
      if (previewCode && import.meta?.env?.DEV) {
        console.info('[auth] preview email code:', previewCode)
      }
      setStatus({
        type: 'success',
        message: previewCode
          ? 'A verification code has been generated for you.'
          : emailSent
            ? `We sent a 6-digit code to ${maskedEmail ?? cleanedEmail}. Enter it below to continue.`
            : 'We generated a 6-digit code. Enter it below once it arrives in your email.',
        previewCode,
        notice,
      })
    } catch (error) {
      if (
        error?.status === 403 ||
        error?.errorType === 'unauthorized_email' ||
        error?.details?.error_type === 'unauthorized_email'
      ) {
        // Profile-email gated access: unknown emails must go through the Service Application flow.
        setStatus({ type: 'idle', message: null, previewCode: null, notice: null })
        setCopyFeedback(null)
        navigate('/ServiceApplication')
        return
      }

      // Provide more specific error messages based on error type
      let message = 'Unable to send verification code.'

      if (error?.message?.includes('not configured') || error?.message?.includes('RESEND_API_KEY')) {
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
      setCopyFeedback(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerify = async (event) => {
    event?.preventDefault?.()
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null })

      const form = event?.currentTarget
      const rawCode = form ? new FormData(form).get('code') : null
      const parsed = codeSchema.safeParse({ code: String(rawCode ?? '') })
      if (!parsed.success) {
        setCodeError(parsed.error.issues?.[0]?.message || 'Enter the 6-digit code we sent')
        return
      }

      setCodeError(null)
      const response = await authStore.verifyEmailCode({ email, code: parsed.data.code, verificationToken })
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
      let message = 'The code you entered was not valid. Try again.'

      if (error?.message?.includes('expired')) {
        message = 'Your verification code has expired. Please request a new one.'
      } else if (error?.message?.includes('invalid') || error?.message?.includes('incorrect')) {
        message = 'Invalid verification code. Please check and try again.'
      } else if (error?.message?.includes('rate limit')) {
        message = 'Too many verification attempts. Please wait a few minutes.'
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

  const handleResend = async () => {
    if (resendCountdown > 0 || !email) return
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })
      const response = await authStore.startEmailSignIn(email)
      setVerificationToken(response?.verification_token ?? null)
      setResendCountdown(45)
      setCopyFeedback(null)
      const previewCode = response?.previewCode ?? null
      const emailSent = response?.email_sent === true
      const notice =
        response?.notice ??
        (previewCode
          ? 'Email delivery is not configured for this environment. Use the generated code below to continue.'
          : !emailSent
            ? 'Email delivery may be delayed. Check spam/junk and try again in a minute if you don’t receive a code.'
          : null)
      setStatus({
        type: 'success',
        message: previewCode
          ? 'A verification code has been generated for you.'
          : emailSent
            ? `We sent a 6-digit code to ${maskedEmail ?? email}. Enter it below to continue.`
            : 'We generated a 6-digit code. Enter it below once it arrives in your email.',
        previewCode,
        notice,
      })
    } catch (error) {
      const message = error?.error || error?.message || 'Unable to resend verification code.'
      setStatus({ type: 'error', message, previewCode: null, notice: null })
    } finally {
      setIsLoading(false)
    }
  }

  const handleCopyPreviewCode = async () => {
    if (!status.previewCode || typeof navigator === 'undefined' || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(status.previewCode)
      setCopyFeedback('Copied!')
      setTimeout(() => setCopyFeedback(null), 1600)
    } catch (error) {
      console.error('Failed to copy verification code:', error)
      setCopyFeedback('Copy failed')
      setTimeout(() => setCopyFeedback(null), 1600)
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
            {status.previewCode ? (
              <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Verification code</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-lg tracking-[0.5em] text-slate-900">{status.previewCode}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCopyPreviewCode}
                    className="shrink-0"
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
                {copyFeedback ? (
                  <p className="mt-1 text-xs text-emerald-600">{copyFeedback}</p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">
                    Enter this code on the next screen. It expires in 10 minutes.
                  </p>
                )}
              </div>
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
            No password required. We'll send a verification code to your email address.
          </p>
        </form>
      ) : null}

      {step === 'code' ? (
        <form onSubmit={handleVerify} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-code">6-digit code</Label>
            <Input
              id="auth-code"
              name="code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="Enter code"
              autoComplete="one-time-code"
              aria-invalid={codeError ? 'true' : 'false'}
            />
            {codeError ? <p className="text-xs text-red-600">{codeError}</p> : null}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Verify &amp; continue
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
              onClick={handleResend}
              disabled={resendCountdown > 0 || isLoading}
              className={cn(
                'inline-flex items-center gap-1 text-blue-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400',
              )}
            >
              <RefreshCw className="h-3 w-3" />
              {resendCountdown > 0 ? `Resend (${resendCountdown}s)` : 'Resend code'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
