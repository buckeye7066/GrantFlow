/**
 * Start.jsx — the SINGLE entry point for new GrantFlow users.
 *
 * Anya runs an adaptive conversational quiz here: each question's options and
 * follow-ups depend on the previous answer, so a church doesn't get asked
 * about scholarships and a college student doesn't get asked about 501(c)(3)
 * status. When the conversation finishes the page collects an email, hands
 * off to /api/onboarding/complete (which creates the profile + credential),
 * then asks for the 6-digit sign-in code and signs the user in.
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
import { useToast } from '@/components/ui/use-toast'
import OnboardingVideo from '@/components/onboarding/OnboardingVideo'

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
  const { toast } = useToast()
  const verifyEmailCode = useAuthStore((s) => s.verifyEmailCode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  const [sessionId, setSessionId] = useState(null)
  const [question, setQuestion] = useState(null)
  const [history, setHistory] = useState([]) // { speaker: 'anya' | 'user', content: ReactNode }[]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Completion + email verify flow
  const [completionPayload, setCompletionPayload] = useState(null)
  const [otpCode, setOtpCode] = useState('')
  const [otpBusy, setOtpBusy] = useState(false)
  const [otpError, setOtpError] = useState(null)
  // How-to video modal (offered on the email step)
  const [showVideo, setShowVideo] = useState(false)

  const scrollerRef = useRef(null)

  // --- Authenticated users skip onboarding entirely ---------------------
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/Dashboard', { replace: true })
    }
  }, [isAuthenticated, navigate])

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
        // Move to completion: ask backend to create user/profile + send code.
        const completed = await apiFetch('/api/onboarding/complete', {
          method: 'POST',
          body: JSON.stringify({ session_id: sessionId }),
        })
        setCompletionPayload(completed)
        setQuestion(null)
        setHistory((prev) => [
          ...prev,
          {
            speaker: 'anya',
            content:
              completed.email_sent
                ? `I just sent a 6-digit sign-in code to ${completed.email}. Drop it in below and we'll start finding matches.`
                : `I generated a sign-in code for ${completed.email}. Email may be slow — give it a minute and check spam if it doesn't show up. You can paste it below.`,
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
  }, [sessionId, question])

  // --- Verify the email OTP and finalise sign-in --------------------------
  const verifyOtp = useCallback(async (e) => {
    e?.preventDefault?.()
    if (!completionPayload?.email) return
    const code = otpCode.replace(/\D/g, '').slice(0, 6)
    if (code.length !== 6) {
      setOtpError('Codes are 6 digits.')
      return
    }
    setOtpError(null)
    setOtpBusy(true)
    try {
      await verifyEmailCode({
        email: completionPayload.email,
        code,
        verificationToken: completionPayload.verification_token,
        profileId: completionPayload.profile_id,
      })
      if (typeof window !== 'undefined') {
        localStorage.removeItem(SESSION_KEY)
      }
      toast({
        title: "You're in!",
        description: "I'm running your first matches now.",
      })
      navigate('/Dashboard', { replace: true })
    } catch (err) {
      setOtpError(err?.message ?? 'That code didn\'t verify. Try again.')
    } finally {
      setOtpBusy(false)
    }
  }, [completionPayload, otpCode, verifyEmailCode, navigate, toast])

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

          {!completionPayload ? renderQuestion() : (
            <div className="ml-12 max-w-md rounded-2xl border border-blue-200 bg-white p-4 shadow-sm">
              <form className="space-y-2" onSubmit={verifyOtp}>
                <Label htmlFor="otp">6-digit sign-in code</Label>
                <Input
                  id="otp"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  autoFocus
                  className="font-mono text-lg tracking-[0.4em]"
                />
                {otpError ? (
                  <p className="text-xs text-red-600">{otpError}</p>
                ) : null}
                {completionPayload.preview_code ? (
                  <p className="text-[11px] text-slate-400">
                    Dev preview: {completionPayload.preview_code}
                  </p>
                ) : null}
                <Button type="submit" disabled={otpBusy} className="w-full gap-2">
                  {otpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  Sign in & start matching
                </Button>
              </form>
            </div>
          )}
        </div>

        <footer className="mt-4 text-center text-xs text-slate-400">
          We never share or sell your information. Your answers stay tied to your profile.
        </footer>
      </div>

      <OnboardingVideo
        open={showVideo}
        onComplete={() => setShowVideo(false)}
        onSkip={() => setShowVideo(false)}
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
