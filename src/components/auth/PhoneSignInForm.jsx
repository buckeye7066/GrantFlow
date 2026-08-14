import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2, PhoneCall, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'

const phoneSchema = z.object({
  phone: z
    .string()
    .min(8, 'Enter a valid mobile number')
    .regex(/^\+?[0-9()\s-]+$/, 'Use digits and optionally + country code'),
})

const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code we texted'),
})

function normalizePhoneInput(phone) {
  if (typeof phone !== 'string') return ''
  const stripped = phone.replace(/[^\d+]/g, '')
  if (!stripped) return ''
  if (stripped.startsWith('+')) {
    return stripped
  }
  return `+${stripped}`
}

export default function PhoneSignInForm({ onComplete }) {
  const phoneForm = useForm({
    resolver: zodResolver(phoneSchema),
    defaultValues: { phone: '' },
  })

  const codeForm = useForm({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  })

  const [step, setStep] = useState('phone')
  const [normalizedPhone, setNormalizedPhone] = useState('')
  const [status, setStatus] = useState({ type: 'idle', message: null })
  const [resendCountdown, setResendCountdown] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const authStore = useAuthStore()

  useEffect(() => {
    if (resendCountdown <= 0) return undefined
    const timer = setInterval(() => setResendCountdown((seconds) => seconds - 1), 1000)
    return () => clearInterval(timer)
  }, [resendCountdown])

  const maskedPhone = useMemo(() => {
    if (!normalizedPhone) return null
    const visible = normalizedPhone.slice(-4)
    return `${normalizedPhone.slice(0, 3)}****${visible}`
  }, [normalizedPhone])

  const handleSendCode = phoneForm.handleSubmit(async (values) => {
    const formatted = normalizePhoneInput(values.phone)
    if (!formatted || formatted.length < 8) {
      phoneForm.setError('phone', { message: 'Enter your phone in international format, e.g. +15551231234' })
      return
    }

    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null })
      const response = await authStore.startPhoneSignIn(formatted)
      setNormalizedPhone(formatted)
      setStep('code')
      setResendCountdown(60)
      if (response?.previewCode && import.meta.env?.DEV) {
        console.info('[auth] preview sms code: ********')
      }
      setStatus({
        type: 'success',
        message: `We texted a 6-digit code to ${maskedPhone ?? formatted}. Enter it below to continue.`,
      })
    } catch (error) {
      const message = error?.error || error?.message || 'Unable to send verification code.'
      setStatus({ type: 'error', message })
    } finally {
      setIsLoading(false)
    }
  })

  const handleVerify = codeForm.handleSubmit(async (values) => {
    try {
      setIsLoading(true)
      setStatus({ type: 'idle', message: null })
      const response = await authStore.verifyPhoneCode({ phone: normalizedPhone, code: values.code })
      if (typeof onComplete === 'function') {
        onComplete(response)
      }
      setStatus({
        type: 'success',
        message: 'Success! Redirecting you to the dashboard…',
      })
    } catch (error) {
      const message = error?.error || error?.message || 'The code you entered was not valid. Try again.'
      setStatus({ type: 'error', message })
    } finally {
      setIsLoading(false)
    }
  })

  const handleResend = () => {
    if (resendCountdown > 0 || !normalizedPhone) return
    phoneForm.setValue('phone', normalizedPhone)
    handleSendCode()
  }

  return (
    <div className="space-y-6">
      {status.type !== 'idle' ? (
        <Alert variant={status.type === 'error' ? 'destructive' : 'default'}>
          {status.type === 'success' ? <PhoneCall className="h-4 w-4" /> : null}
          <AlertTitle>{status.type === 'error' ? 'Something went wrong' : 'Check your phone'}</AlertTitle>
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      ) : null}

      {step === 'phone' ? (
        <form onSubmit={handleSendCode} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-phone">Mobile number</Label>
            <Input
              id="auth-phone"
              type="tel"
              placeholder="+1 555 123 1234"
              {...phoneForm.register('phone')}
              aria-invalid={phoneForm.formState.errors.phone ? 'true' : 'false'}
            />
            {phoneForm.formState.errors.phone ? (
              <p className="text-xs text-red-600">{phoneForm.formState.errors.phone.message}</p>
            ) : (
              <p className="text-xs text-slate-500">
                Use the phone number on file with your GrantFlow application. Include country code.
              </p>
            )}
          </div>
          <Button type="submit" disabled={isLoading} className="w-full">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Text me a code
          </Button>
        </form>
      ) : null}

      {step === 'code' ? (
        <form onSubmit={handleVerify} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="auth-phone-code">6-digit code</Label>
            <Input
              id="auth-phone-code"
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
              onClick={() => setStep('phone')}
              className={cn('text-blue-600 hover:underline', isLoading && 'pointer-events-none opacity-60')}
            >
              Use a different number
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
