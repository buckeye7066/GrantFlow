import React from "react"
import { getAnyaRun } from "@/lib/anyaClient"
import { toast } from "@/components/ui/use-toast"
import { ToastAction } from "@/components/ui/toast"
import { createLogger } from "@/utils/logger"

// ---------------------------------------------------------------------------
// Anya background reply queue
// ---------------------------------------------------------------------------
//
// When a message is sent with background=true the server returns immediately
// with a run_id and finishes the reply out of band (see backend/routes/anya.js).
// This module is the client side of that: a process-wide singleton that tracks
// in-flight background runs, polls their status, and pings the user when a reply
// is ready — even if they have closed the Anya panel (which unmounts <AnyaChat>)
// or reloaded the page (pending runs are persisted to localStorage and resumed).
//
// Consumers:
//   • <AnyaChat> subscribes so an OPEN panel on that session shows the reply live.
//   • The toast ping below works with no panel mounted at all; its "Open" action
//     re-opens Anya on the exact session that holds the answer.
// ---------------------------------------------------------------------------

const log = createLogger("AnyaBackgroundQueue")

const LS_KEY = "grantflow:anya-bg-runs"
const POLL_MS = 2500
// Stop chasing a run after this long — a wedged/cancelled run shouldn't poll
// forever. The server bounds generation well under this (ANYA_BG_REPLY_TIMEOUT_MS).
const MAX_AGE_MS = 10 * 60 * 1000

/** @type {Map<string, {runId:string, sessionId:string, profileId:string|null, question:string, startedAt:number}>} */
const pending = new Map()
const listeners = new Set()
let timer = null

function persist() {
  try {
    if (typeof window === "undefined") return
    window.localStorage.setItem(LS_KEY, JSON.stringify(Array.from(pending.values())))
  } catch {
    // Best-effort; an over-quota/private-mode failure just loses reload-resume.
  }
}

function hydrate() {
  try {
    if (typeof window === "undefined") return
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return
    const rows = JSON.parse(raw)
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (row?.runId && row?.sessionId) {
        pending.set(row.runId, {
          runId: row.runId,
          sessionId: row.sessionId,
          profileId: row.profileId ?? null,
          question: row.question ?? "",
          // If a stored run is already older than MAX_AGE it is dropped on the
          // first poll; otherwise keep its original age so cleanup stays honest.
          startedAt: Number(row.startedAt) || Date.now(),
        })
      }
    }
  } catch {
    // Corrupt payload — ignore and start clean.
  }
}

function emit(event) {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      log.warn("background listener threw", err?.message || err)
    }
  }
}

/**
 * Subscribe to background reply events. Returns an unsubscribe fn.
 * Event shape: { type: "reply-ready", runId, sessionId, run }
 */
export function subscribeAnyaBackground(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Register an in-flight background run for polling + ping. */
export function enqueueAnyaBackgroundRun({ runId, sessionId, profileId, question } = {}) {
  if (!runId || !sessionId) return
  pending.set(runId, {
    runId,
    sessionId,
    profileId: profileId ?? null,
    question: typeof question === "string" ? question : "",
    startedAt: Date.now(),
  })
  persist()
  ensurePolling()
}

function ensurePolling() {
  if (timer || pending.size === 0 || typeof window === "undefined") return
  timer = window.setInterval(poll, POLL_MS)
  // Kick one immediately so a freshly-hydrated already-done run pings fast.
  poll()
}

function stopPollingIfIdle() {
  if (pending.size === 0 && timer) {
    window.clearInterval(timer)
    timer = null
  }
}

function truncate(text, max) {
  const s = String(text || "").trim()
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

function openAnyaSession(entry) {
  if (typeof window === "undefined") return
  // resumeSessionId tells <AnyaChat> to load THIS session's thread instead of
  // minting a fresh one — the only sanctioned way to resurface a prior session
  // (the user explicitly asked to see this answer), so it doesn't violate the
  // "fresh panel on open" rule.
  window.dispatchEvent(
    new CustomEvent("anya:open", {
      detail: { profileId: entry.profileId ?? null, resumeSessionId: entry.sessionId },
    }),
  )
}

function pingReady(entry, run) {
  const succeeded = run?.status === "completed" && !run?.degraded
  toast({
    duration: 12000,
    variant: succeeded ? undefined : "destructive",
    title: succeeded ? "Anya has your answer" : "Anya hit a snag",
    description: succeeded
      ? truncate(run?.assistant_text || "Open Anya to read the full reply.", 160)
      : "Open Anya to see what happened and try again.",
    action: (
      <ToastAction altText="Open Anya" onClick={() => openAnyaSession(entry)}>
        Open
      </ToastAction>
    ),
  })
}

async function poll() {
  if (pending.size === 0) {
    stopPollingIfIdle()
    return
  }
  const entries = Array.from(pending.values())
  for (const entry of entries) {
    if (Date.now() - entry.startedAt > MAX_AGE_MS) {
      pending.delete(entry.runId)
      persist()
      continue
    }
    let run = null
    try {
      run = await getAnyaRun(entry.sessionId, entry.runId)
    } catch (err) {
      // A 404 means the run is gone (e.g. server restarted before it finished) —
      // stop chasing it. Any other error is transient; keep polling.
      if (err?.status === 404) {
        pending.delete(entry.runId)
        persist()
      }
      continue
    }
    if (!run) continue
    if (run.status === "completed" || run.status === "failed") {
      pending.delete(entry.runId)
      persist()
      emit({ type: "reply-ready", runId: entry.runId, sessionId: entry.sessionId, run })
      pingReady(entry, run)
    }
  }
  stopPollingIfIdle()
}

// Resume any runs that were in flight when the page was last open.
if (typeof window !== "undefined") {
  hydrate()
  // Defer so the toast provider has mounted before any immediate ping fires.
  window.setTimeout(ensurePolling, 1500)
}
