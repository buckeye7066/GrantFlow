import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
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
  const emailForm = useForm({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
  })

  const codeForm = useForm({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  })

  const [step, setStep] = useState('email')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState({ type: 'idle', message: null, previewCode: null, notice: null })
  const [verificationToken, setVerificationToken] = useState(null)
  const [resendCountdown, setResendCountdown] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(null)
  const authStore = useAuthStore()

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

  const handleSendCode = emailForm.handleSubmit(async (values) => {
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null, previewCode: null, notice: null })
      const cleanedEmail = normalizeEmail(values.email)
      const response = await authStore.startEmailSignIn(cleanedEmail)
      setEmail(cleanedEmail)
      setVerificationToken(response?.verification_token ?? null)
      setStep('code')
      setResendCountdown(45)
      setCopyFeedback(null)
      const previewCode = response?.previewCode ?? null
      const notice =
        response?.notice ??
        (previewCode
          ? 'Email delivery is not configured for this environment. Use the generated code below to continue.'
          : null)
      if (previewCode) {
        console.info('[auth] preview email code:', previewCode)
      }
      setStatus({
        type: 'success',
        message: previewCode
          ? 'A verification code has been generated for you.'
          : `We sent a 6-digit code to ${maskedEmail ?? values.email}. Enter it below to continue.`,
        previewCode,
        notice,
      })
    } catch (error) {
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
  })

  const handleVerify = codeForm.handleSubmit(async (values) => {
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null })
      const response = await authStore.verifyEmailCode({ email, code: values.code, verificationToken })
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
  })

  const handleResend = () => {
    if (resendCountdown > 0 || !email) return
    emailForm.setValue('email', email)
    handleSendCode()
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
              type="email"
              placeholder="jane@example.org"
              {...emailForm.register('email')}
              aria-invalid={emailForm.formState.errors.email ? 'true' : 'false'}
            />
            {emailForm.formState.errors.email ? (
              <p className="text-xs text-red-600">{emailForm.formState.errors.email.message}</p>
            ) : null}
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
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="Enter code"
              {...codeForm.register('code')}
              aria-invalid={codeForm.formState.errors.code ? 'true' : 'false'}
            />
            {codeForm.formState.errors.code ? (
              <p className="text-xs text-red-600">{codeForm.formState.errors.code.message}</p>
            ) : null}
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
