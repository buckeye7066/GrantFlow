import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import {
  CalendarClock,
  MessageCircle,
  MessageCircleCode,
  Moon,
  Phone,
  Printer,
  Send,
  Sun,
} from 'lucide-react'
import { useExperience } from '../../contexts/ExperienceContext'

type AppShellProps = {
  children: ReactNode
}

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/organizations', label: 'Organizations' },
]

function KeyboardShortcuts() {
  const { markSaved } = useExperience()
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isSaveCombo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'
      if (isSaveCombo) {
        event.preventDefault()
        markSaved()
        setToast('Progress saved (Ctrl+S)')
        window.dispatchEvent(new CustomEvent('grantflow:save'))
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [markSaved])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 2500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  if (!toast) return null
  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-200 dark:text-slate-900">
      {toast}
    </div>
  )
}

function SessionTimeoutNotice() {
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000
  const WARNING_THRESHOLD_MS = 5 * 60 * 1000
  const [lastActive, setLastActive] = useState<number>(Date.now())
  const [showWarning, setShowWarning] = useState(false)

  useEffect(() => {
    const updateActivity = () => setLastActive(Date.now())
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']
    events.forEach((event) => window.addEventListener(event, updateActivity))
    return () => events.forEach((event) => window.removeEventListener(event, updateActivity))
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const inactiveMs = Date.now() - lastActive
      if (inactiveMs >= SESSION_TIMEOUT_MS) {
        setShowWarning(true)
      } else if (inactiveMs >= SESSION_TIMEOUT_MS - WARNING_THRESHOLD_MS) {
        setShowWarning(true)
      } else {
        setShowWarning(false)
      }
    }, 30_000)

    return () => window.clearInterval(interval)
  }, [lastActive])

  if (!showWarning) return null

  const minutesRemaining = Math.max(0, Math.ceil((SESSION_TIMEOUT_MS - (Date.now() - lastActive)) / 60_000))

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-800 shadow-lg dark:border-amber-400/40 dark:bg-amber-950/80 dark:text-amber-200">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4" aria-hidden />
          <span>
            Session will time out in <strong>{minutesRemaining} minute{minutesRemaining === 1 ? '' : 's'}</strong>. Stay
            active to keep your work.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setLastActive(Date.now())}
          className="rounded-lg bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
        >
          Stay signed in
        </button>
      </div>
    </div>
  )
}

export function AppShell({ children }: AppShellProps) {
  const { theme, toggleTheme, lastSavedLabel } = useExperience()
  const location = useLocation()

  const pageTitle = useMemo(() => {
    const current = NAV_ITEMS.find((item) => item.to === location.pathname)
    return current?.label ?? 'GrantFlow'
  }, [location.pathname])

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 transition-colors duration-200 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              GrantFlow
            </Link>
            <nav aria-label="Main navigation" className="hidden items-center gap-4 text-sm font-medium text-slate-600 sm:flex">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-2 transition ${
                      isActive
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden flex-col text-xs text-slate-500 sm:flex dark:text-slate-400">
              <span className="font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">Status</span>
              <span>Last saved: {lastSavedLabel}</span>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="h-3.5 w-3.5" aria-hidden />
                  Light
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5" aria-hidden />
                  Dark
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Printer className="h-3.5 w-3.5" aria-hidden />
              Export PDF
            </button>
            <a
              href="https://calendly.com/drjohnwhite/strategy-session"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-blue-700"
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              Schedule Consultation
            </a>
            <a
              href="https://wa.me/14235047778"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100 sm:inline-flex"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              WhatsApp
            </a>
            <a
              href="sms:+14235047778"
              className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 sm:inline-flex dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Phone className="h-3.5 w-3.5" aria-hidden />
              SMS
            </a>
          </div>
        </div>
        <div className="border-t border-slate-100 bg-slate-50/80 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          <div className="mx-auto flex max-w-6xl items-center justify-between">
            <span>{pageTitle}</span>
            <span className="flex items-center gap-1">
              <MessageCircleCode className="h-3.5 w-3.5" aria-hidden />
              Need help? Email{' '}
              <a className="font-medium text-blue-600 hover:underline" href="mailto:Dr.JohnWhite@axiombiolabs.org">
                Dr.JohnWhite@axiombiolabs.org
              </a>
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col">
        <main className="flex-1">{children}</main>
        <footer className="border-t border-slate-200 bg-white px-4 py-4 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>© {new Date().getFullYear()} GrantFlow. All rights reserved.</span>
            <div className="flex flex-wrap items-center gap-3">
              <a href="tel:14235047778" className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200">
                <Phone className="h-3.5 w-3.5" aria-hidden />
                423-504-7778
              </a>
              <a
                href="mailto:Dr.JohnWhite@axiombiolabs.org"
                className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <Send className="h-3.5 w-3.5" aria-hidden />
                Email support
              </a>
            </div>
          </div>
        </footer>
      </div>

      <KeyboardShortcuts />
      <SessionTimeoutNotice />
    </div>
  )
}


