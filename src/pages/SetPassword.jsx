import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import * as z from 'zod'
import AuthShell from '@/components/auth/AuthShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import LoginMaintenanceNotice from '@/components/auth/LoginMaintenanceNotice'
import { isLoginMaintenanceActive } from '@/config/maintenance'

const schema = z
  .object({
    password: z.string().min(10, 'Password must be at least 10 characters long'),
    confirm: z.string().min(10, 'Password must be at least 10 characters long'),
  })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] })

export default function SetPassword() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = (params.get('token') || '').trim()
  const completePasswordSetup = useAuthStore((s) => s.completePasswordSetup)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  const tokenMissing = useMemo(() => !token, [token])

  const maintenanceActive = isLoginMaintenanceActive()

  const onSubmit = async (e) => {
    e?.preventDefault?.()
    if (maintenanceActive) return
    if (tokenMissing) return

    const parsed = schema.safeParse({ password, confirm })
    if (!parsed.success) {
      setError(parsed.error.issues?.[0]?.message || 'Invalid password')
      return
    }

    setError(null)
    setIsLoading(true)
    try {
      await completePasswordSetup({ token, password: parsed.data.password })
      navigate('/Dashboard', { replace: true })
    } catch (err) {
      setError(err?.message || 'Unable to set password')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <AuthShell title="Set your password" subtitle="Choose a strong password to finish signing in.">
      {maintenanceActive ? (
        <LoginMaintenanceNotice />
      ) : (
      <>
      {tokenMissing ? (
        <Alert variant="destructive">
          <AlertTitle>Missing link token</AlertTitle>
          <AlertDescription>
            This password setup link is incomplete. Return to the login page and request a new link.
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <div className="mt-4">
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={tokenMissing || isLoading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm password</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={tokenMissing || isLoading}
          />
        </div>
        <Button type="submit" disabled={tokenMissing || isLoading} className="w-full">
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Set password &amp; sign in
        </Button>
        <div className="text-center text-xs text-slate-500">
          <Link to="/login" className="text-blue-600 hover:underline">
            Back to login
          </Link>
        </div>
      </form>
      </>
      )}
    </AuthShell>
  )
}

