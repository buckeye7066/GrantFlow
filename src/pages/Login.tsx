import { type FormEvent, useEffect, useState } from 'react'
import { Loader2, LogIn, ShieldCheck } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAdmin } from '../contexts/AdminContext'

export default function Login() {
  const { isAdmin, login, loading, error } = useAdmin()
  const navigate = useNavigate()
  const location = useLocation()
  const [token, setToken] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (isAdmin) {
      const next = (location.state as { from?: string } | null)?.from || '/'
      navigate(next, { replace: true })
    }
  }, [isAdmin, navigate, location.state])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) {
      setLocalError('Provide an admin token to continue.')
      return
    }
    try {
      await login(trimmed)
      setLocalError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed'
      setLocalError(message)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-900/5 px-4 py-12 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-600/10 text-blue-600">
            <ShieldCheck className="h-6 w-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">GrantFlow Control Center</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Sign in with your administrator token.</p>
          </div>
        </header>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Admin token
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/40"
              placeholder="•••••••••••••"
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-75"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4" aria-hidden />}
            Access dashboard
          </button>
        </form>

        {(localError || error) && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-400/40 dark:bg-amber-900/30 dark:text-amber-100">
            {localError ?? error}
          </p>
        )}

        <p className="mt-6 text-xs text-slate-500 dark:text-slate-400">
          Keep this tab secured. Tokens are stored for the session only and cleared when you sign out or close your browser.
        </p>
      </div>
    </main>
  )
}
