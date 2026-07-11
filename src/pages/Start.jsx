/**
 * Start.jsx — the SINGLE entry point for new GrantFlow users.
 *
 * Anya runs an adaptive conversational quiz here: each question's options and
 * follow-ups depend on the previous answer, so a church doesn't get asked
 * about scholarships and a college student doesn't get asked about 501(c)(3)
 * status. When the conversation finishes the page collects an email and hands
 * off to /api/onboarding/complete, which creates the profile + user and emails
 * the SAME secure /set-password link the login page uses — no sign-in codes.
 *
 * Mission goals: this is goal #7 (clear discovery UI) and the key onramp for
 * goals 1-6 — we collect the canonical signals the matching engine needs in
 * a single, friendly flow.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { Loader2, Send, CheckCircle2, Sparkles, MapPin, Mail, ArrowRight, PlayCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import OnboardingVideo from '@/components/onboarding/OnboardingVideo'
import { useLanguage } from '@/i18n'

const SESSION_KEY = 'grantflow:onboarding-session'
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
]

// ---------------------------------------------------------------------------
// Anya bubble — keep visual consistency with AnyaChat
// ---------------------------------------------------------------------------
function AnyaBubble({ children }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-500 text-white shadow-sm">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="flex-1 rounded-2xl rounded-tl-sm border border-blue-200 bg-blue-50/70 px-4 py-3 text-sm leading-relaxed text-slate-800 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">Anya</span>
        </div>
        <div className="whitespace-pre-wrap">{children}</div>
      </div>
    </div>
  )
}

function UserBubble({ children }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-slate-900 px-4 py-2 text-sm leading-relaxed text-white shadow-sm">
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Question renderers
// ---------------------------------------------------------------------------
function ChoiceQuestion({ question, onSubmit, busy }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {question.options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={busy}
          onClick={() => onSubmit(opt.value)}
          className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium text-slate-800 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-400 hover:bg-blue-50/60 hover:text-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function MultiChoiceQuestion({ question, onSubmit, busy }) {
  const [selected, setSelected] = useState(new Set())
  const toggle = (value) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }
  const canSubmit = question.optional || selected.size > 0
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {question.options.map((opt) => {
          const active = selected.has(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              disabled={busy}
              onClick={() => toggle(opt.value)}
              className={cn(
                'rounded-xl border px-4 py-3 text-left text-sm font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60',
                active
                  ? 'border-blue-500 bg-blue-50 text-blue-900'
                  : 'border-slate-200 bg-white text-slate-800 hover:border-blue-300 hover:bg-blue-50/40 hover:text-blue-800',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{opt.label}</span>
                {active ? <CheckCircle2 className="h-4 w-4 text-blue-600" /> : null}
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">
          {selected.size > 0
            ? `${selected.size} selected`
            : question.optional ? 'Optional' : 'Pick at least one'}
        </span>
        <Button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => onSubmit(Array.from(selected))}
          className="gap-2"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Continue
        </Button>
      </div>
    </div>
  )
}

function LocationQuestion({ question, onSubmit, busy }) {
  const [zip, setZip] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [city, setCity] = useState('')
  const [county, setCounty] = useState('')
  const [zipLooking, setZipLooking] = useState(false)
  const canSubmit = /^\d{5}(-\d{4})?$/.test(zip.trim()) && /^[A-Z]{2}$/.test(stateCode.trim().toUpperCase())

  // Auto-fill city + state the moment a valid 5-digit ZIP is entered. We
  // overwrite city/state (the ZIP is authoritative) but only fill county when
  // it's still blank, so a user who typed their own county isn't overridden.
  useEffect(() => {
    const z = zip.trim()
    if (!/^\d{5}$/.test(z)) return
    let cancelled = false
    setZipLooking(true)
    apiFetch(`/api/onboarding/zip/${z}`)
      .then((loc) => {
        if (cancelled || !loc) return
        if (loc.state) setStateCode(loc.state.toUpperCase())
        if (loc.city) setCity(loc.city)
        if (loc.county) setCounty((prev) => prev.trim() ? prev : loc.county)
      })
      .catch(() => { /* unknown ZIP — leave fields for manual entry */ })
      .finally(() => { if (!cancelled) setZipLooking(false) })
    return () => { cancelled = true }
  }, [zip])
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSubmit) return
        onSubmit({
          zip: zip.trim(),
          state: stateCode.trim().toUpperCase(),
          city: city.trim() || undefined,
          county: county.trim() || undefined,
        })
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="zip">ZIP code</Label>
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="zip"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              placeholder="37205"
              inputMode="numeric"
              autoComplete="postal-code"
              autoFocus
              className="pl-9"
            />
            {zipLooking ? (
              <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
            ) : null}
          </div>
          <p className="mt-1 text-xs text-slate-500">I'll fill in your city and state automatically.</p>
        </div>
        <div>
          <Label htmlFor="state">State</Label>
          <select
            id="state"
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select state…</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="city">City <span className="text-xs text-slate-500">(optional)</span></Label>
          <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Nashville" />
        </div>
        <div>
          <Label htmlFor="county">County <span className="text-xs text-slate-500">(optional)</span></Label>
          <Input id="county" value={county} onChange={(e) => setCounty(e.target.value)} placeholder="Davidson" />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit || busy} className="gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Continue
        </Button>
      </div>
    </form>
  )
}

function TextQuestion({ question, onSubmit, busy, multiline = false }) {
  const [value, setValue] = useState('')
  const InputCmp = multiline ? Textarea : Input
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = value.trim()
        if (!question.optional && !trimmed) return
        onSubmit(trimmed)
      }}
    >
      <InputCmp
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={question.placeholder ?? ''}
        rows={multiline ? 4 : undefined}
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        {question.optional ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSubmit('')}
          >
            Skip
          </Button>
        ) : <span />}
        <Button
          type="submit"
          disabled={busy || (!question.optional && !value.trim())}
          className="gap-2"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Continue
        </Button>
      </div>
    </form>
  )
}

function EmailQuestion({ question, onSubmit, busy, onWatchVideo }) {
  const [value, setValue] = useState('')
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit(value.trim().toLowerCase())
      }}
    >
      <div className="relative">
        <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={question.placeholder ?? 'you@example.com'}
          autoComplete="email"
          autoFocus
          className="pl-9"
        />
      </div>
      <p className="text-xs text-slate-500">{question.help}</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !valid} className="gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Send my sign-in code
        </Button>
      </div>
      <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5">
        <p className="text-xs text-slate-600">
          New to GrantFlow? Take 2 minutes to see how it works —{' '}
          <button
            type="button"
            onClick={onWatchVideo}
            className="inline-flex items-center gap-1 font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            watch the how-to video
          </button>
          .
        </p>
      </div>
    </form>
  )
}

function AnnounceQuestion({ question, onSubmit, busy }) {
  return (
    <div className="flex justify-end">
      <Button onClick={() => onSubmit(null)} disabled={busy} className="gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {question.cta ?? "Let's go"}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Start() {
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const startPasswordSetup = useAuthStore((s) => s.startPasswordSetup)
  const { setLanguage } = useLanguage()

  const [sessionId, setSessionId] = useState(null)
  const [question, setQuestion] = useState(null)
  const [history, setHistory] = useState([]) // { speaker: 'anya' | 'user', content: ReactNode }[]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Completion → "check your email for the set-password link" panel
  const [completionPayload, setCompletionPayload] = useState(null)
  const [resendBusy, setResendBusy] = useState(false)
  const [resendNotice, setResendNotice] = useState(null)
  // How-to video modal (offered on the email step, or auto-played first)
  const [showVideo, setShowVideo] = useState(false)
  // The intro video now plays automatically before the interview begins, once
  // per browser — re-watching later (via the email step's "watch video" link)
  // doesn't re-trigger the auto-play.
  const [introVideoSeen, setIntroVideoSeen] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('grantflow:intro_video_seen') === '1'
  })
  const markIntroVideoSeen = useCallback(() => {
    try {
      window.localStorage.setItem('grantflow:intro_video_seen', '1')
    } catch {
      // ignore (private browsing / storage disabled) — worst case the video re-plays next visit
    }
    setIntroVideoSeen(true)
    setShowVideo(false)
  }, [])

  const scrollerRef = useRef(null)

  // --- Already-authenticated users skip onboarding entirely --------------
  // Gated on !completionPayload so a signed-in user who somehow lands here
  // mid-completion isn't yanked away from the "check your email" panel.
  useEffect(() => {
    if (isAuthenticated && !completionPayload) {
      navigate('/Dashboard', { replace: true })
    }
  }, [isAuthenticated, completionPayload, navigate])

  // --- Resume an in-flight session if we have one ------------------------
  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      const stored = typeof window !== 'undefined'
        ? localStorage.getItem(SESSION_KEY)
        : null
      if (stored) {
        try {
          const resumed = await apiFetch(`/api/onboarding/sessions/${stored}`)
          if (!cancelled && resumed?.session_id && resumed?.status === 'in_progress' && resumed.question) {
            setSessionId(resumed.session_id)
            setQuestion(resumed.question)
            setHistory([{ speaker: 'anya', content: resumed.question.prompt }])
            return
          }
        } catch {
          // fall through to start a new session
        }
      }
      try {
        const created = await apiFetch('/api/onboarding/start', { method: 'POST' })
        if (cancelled) return
        if (typeof window !== 'undefined') {
          localStorage.setItem(SESSION_KEY, created.session_id)
        }
        setSessionId(created.session_id)
        setQuestion(created.question)
        setHistory([{ speaker: 'anya', content: created.question?.prompt ?? '' }])
      } catch (err) {
        if (cancelled) return
        setError(err?.message ?? 'Could not start the onboarding session.')
      }
    }
    bootstrap()
    return () => { cancelled = true }
  }, [])

  // --- Auto-scroll on new bubble -----------------------------------------
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
    }
  }, [history, question, completionPayload])

  // --- Submit an answer ---------------------------------------------------
  const submitAnswer = useCallback(async (answer) => {
    if (!sessionId || !question) return
    setError(null)
    // Language is the first question — apply the choice immediately so the rest
    // of the onboarding chrome (and the whole app) switches right away. The
    // backend also persists it to the profile when onboarding completes.
    if (question.id === 'language' && typeof answer === 'string') {
      try { setLanguage(answer) } catch { /* provider always mounted at root */ }
    }
    setBusy(true)
    setHistory((prev) => [
      ...prev,
      { speaker: 'user', content: renderUserAnswer(question, answer) },
    ])
    try {
      const result = await apiFetch('/api/onboarding/answer', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          question_id: question.id,
          answer,
        }),
      })
      if (result?.complete) {
        // Move to completion: backend creates the user/profile and emails the
        // secure /set-password link (the same flow as the login page).
        const completed = await apiFetch('/api/onboarding/complete', {
          method: 'POST',
          body: JSON.stringify({ session_id: sessionId }),
        })

        // Dev/smoke convenience: no email service locally, so hop straight to
        // the set-password page with the previewed token (mirrors EmailSignInForm).
        const smokeMode = String(import.meta?.env?.VITE_SMOKE_MODE || '').toLowerCase() === 'true'
        if (completed?.preview_token && (import.meta?.env?.DEV || smokeMode)) {
          if (typeof window !== 'undefined') {
            localStorage.removeItem(SESSION_KEY)
          }
          navigate(`/set-password?token=${encodeURIComponent(String(completed.preview_token))}`)
          return
        }

        if (typeof window !== 'undefined') {
          localStorage.removeItem(SESSION_KEY)
        }
        setCompletionPayload(completed)
        setQuestion(null)
        setHistory((prev) => [
          ...prev,
          {
            speaker: 'anya',
            content:
              completed.signin_flow === 'password_exists'
                ? `You already have a GrantFlow password — sign in with ${completed.email} and I'll put your answers to work.`
                : completed.email_sent
                  ? `I just emailed a secure sign-in link to ${completed.email}. Open it, set your password, and you're in — I'll take it from there.`
                  : `I created your sign-in link for ${completed.email}. Email can be slow — give it a minute and check spam, or resend it below.`,
          },
        ])
      } else if (result?.question) {
        setQuestion(result.question)
        setHistory((prev) => [
          ...prev,
          { speaker: 'anya', content: result.question.prompt },
        ])
      }
    } catch (err) {
      setError(err?.message ?? 'Something went wrong. Try once more?')
    } finally {
      setBusy(false)
    }
  }, [sessionId, question, setLanguage, navigate])

  // --- Resend the set-password link (same endpoint the login page uses) ---
  const resendSetupLink = useCallback(async () => {
    if (!completionPayload?.email || resendBusy) return
    setResendBusy(true)
    setResendNotice(null)
    try {
      await startPasswordSetup(completionPayload.email)
      setResendNotice(`Sent! Check ${completionPayload.email} (and spam) for the new link.`)
    } catch (err) {
      setResendNotice(err?.error || err?.message || 'Could not resend the link. Try again in a minute.')
    } finally {
      setResendBusy(false)
    }
  }, [completionPayload, resendBusy, startPasswordSetup])

  const renderQuestion = () => {
    if (!question) return null
    switch (question.kind) {
      case 'announce':     return <AnnounceQuestion question={question} onSubmit={submitAnswer} busy={busy} />
      case 'choice':       return <ChoiceQuestion question={question} onSubmit={submitAnswer} busy={busy} />
      case 'multi_choice': return <MultiChoiceQuestion key={question.id} question={question} onSubmit={submitAnswer} busy={busy} />
      case 'location':     return <LocationQuestion question={question} onSubmit={submitAnswer} busy={busy} />
      case 'long_text':    return <TextQuestion question={question} onSubmit={submitAnswer} busy={busy} multiline />
      case 'text':         return <TextQuestion question={question} onSubmit={submitAnswer} busy={busy} />
      case 'email':        return <EmailQuestion question={question} onSubmit={submitAnswer} busy={busy} onWatchVideo={() => setShowVideo(true)} />
      default:             return null
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-blue-50/30">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-8">
        <header className="mb-6 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-slate-800 hover:text-blue-700">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-purple-600 text-white shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="text-base font-semibold tracking-tight">GrantFlow</span>
          </Link>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {!completionPayload ? (
              <Link
                to="/"
                className="hover:text-blue-700"
                title="Your answers save automatically — come back to this page anytime to pick up where you left off."
              >
                Save &amp; finish later
              </Link>
            ) : null}
            <Link to="/login" className="hover:text-blue-700">Returning user? Sign in</Link>
          </div>
        </header>

        <div
          ref={scrollerRef}
          className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white/70 p-5 shadow-sm backdrop-blur"
        >
          {history.map((row, idx) => (
            row.speaker === 'anya'
              ? <AnyaBubble key={idx}>{row.content}</AnyaBubble>
              : <UserBubble key={idx}>{row.content}</UserBubble>
          ))}

          {question?.help ? (
            <p className="ml-12 text-xs italic text-slate-500">{question.help}</p>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {!completionPayload ? renderQuestion() : completionPayload.signin_flow === 'password_exists' ? (
            <div className="ml-12 max-w-md rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
                <div className="text-sm leading-relaxed text-slate-800">
                  <p className="font-semibold text-blue-700">Welcome back!</p>
                  <p className="mt-1">
                    You already have a password for {completionPayload.email}. Sign in and your new
                    answers go straight to work.
                  </p>
                </div>
              </div>
              <Button onClick={() => navigate('/login')} className="mt-4 w-full gap-2">
                <ArrowRight className="h-4 w-4" />
                Go to sign in
              </Button>
            </div>
          ) : (
            <div className="ml-12 max-w-md rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
                <div className="text-sm leading-relaxed text-slate-800">
                  <p className="font-semibold text-blue-700">One last step — check your email</p>
                  <p className="mt-1">
                    We sent a secure link to <span className="font-medium">{completionPayload.email}</span>.
                    Open it to set your password and you'll land right on your dashboard. The link
                    expires in 30 minutes.
                  </p>
                </div>
              </div>
              {resendNotice ? (
                <p className="mt-3 text-xs text-slate-600">{resendNotice}</p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                onClick={resendSetupLink}
                disabled={resendBusy}
                className="mt-4 w-full gap-2"
              >
                {resendBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Resend the link
              </Button>
            </div>
          )}
        </div>

        <footer className="mt-4 text-center text-xs text-slate-500">
          We never share or sell your information. Your answers stay tied to your profile.
          {!completionPayload ? (
            <>
              {' '}Answers save automatically — you can close this page and pick up right where you left off.
            </>
          ) : null}
        </footer>
      </div>

      <OnboardingVideo
        open={!introVideoSeen || showVideo}
        onComplete={markIntroVideoSeen}
        onSkip={markIntroVideoSeen}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderUserAnswer(question, answer) {
  if (!question) return String(answer ?? '')
  if (question.kind === 'announce') return null
  if (question.kind === 'multi_choice') {
    const list = Array.isArray(answer) ? answer : []
    if (list.length === 0) return 'No selection'
    return (
      <div className="flex flex-wrap gap-1.5">
        {list.map((value) => {
          const opt = question.options?.find((o) => o.value === value)
          return (
            <Badge key={value} className="bg-white/15 text-white">
              {opt?.label ?? value}
            </Badge>
          )
        })}
      </div>
    )
  }
  if (question.kind === 'choice') {
    const opt = question.options?.find((o) => o.value === answer)
    return opt?.label ?? String(answer)
  }
  if (question.kind === 'location') {
    const parts = [
      answer?.zip,
      answer?.state,
      answer?.city,
      answer?.county,
    ].filter(Boolean)
    return parts.join(' · ')
  }
  if (typeof answer === 'string') {
    return answer.trim() || '(skipped)'
  }
  return JSON.stringify(answer)
}
