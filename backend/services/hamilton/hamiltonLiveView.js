/**
 * Live browser view — a low-fps CDP screencast of Hamilton's real portal browser,
 * so the owner can watch a run fill and submit an application in near-real time
 * (owner request 2026-08-21: "show the open portal and Hamilton entering
 * information", not a static "working" label).
 *
 * DESIGN + SAFETY CONTRACT
 *  - EPHEMERAL ONLY. A frame is a picture of a half-filled application form — it
 *    can carry PII (name, address, essay, an identity field mid-keystroke). It
 *    is NEVER written to disk or the DB; it lives in memory, only the LATEST
 *    frame per run, and is served only to the profile's owner/admin over the
 *    existing auth. Frames are age-evicted so a crashed run cannot leak memory,
 *    and the whole run entry is cleared when the run ends.
 *  - NEVER BREAKS A RUN. Screencast is a side channel. Every capture path is
 *    wrapped; a CDP failure, an ack failure, or a store error is swallowed and
 *    the autopilot run proceeds exactly as if live view did not exist.
 *  - HEADLESS-COMPATIBLE. CDP `Page.startScreencast` streams frames from a
 *    headless Chromium, so no headed browser / xvfb is required.
 */

const FRAME_TTL_MS = 15_000 // a frame older than this is "between steps" → not served as live
const STEP_TTL_MS = 5 * 60_000 // a step label outlives a frame — it is the "what is Hamilton doing" text
const MAX_RUNS = 25 // most concurrent runs we retain a frame for; evict oldest beyond this

// runId -> { frame: base64 jpeg|null, frameTs: ms, step: string|null, stepDetail, stepTs, status }
// Two channels share one entry: the VIDEO frame (only while a run is actively
// rendering) and the STEP label (a plain-text play-by-play that is available
// even when no frame is — queued/blocked/between-steps). One endpoint serves
// both, so the watch window always has something to show.
const store = new Map()

function ensureEntry(runId, now) {
  let entry = store.get(String(runId))
  if (!entry) {
    entry = { frame: null, frameTs: 0, step: null, stepDetail: null, stepTs: now(), status: 'running' }
    store.set(String(runId), entry)
    if (store.size > MAX_RUNS) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of store) {
        const t = Math.max(v.frameTs || 0, v.stepTs || 0)
        if (t < oldestTs) { oldestTs = t; oldestKey = k }
      }
      if (oldestKey !== null) store.delete(oldestKey)
    }
  }
  return entry
}

/**
 * Record the current STEP (the play-by-play the list view shows). Cheap enough
 * to call from every engine milestone. `detail` is an optional object (e.g.
 * {filled, total, host}) rendered as context. NEVER include a field VALUE — the
 * step channel is served to the UI and persisted nowhere, but the same
 * no-secret discipline as the run trace applies.
 */
export function reportLiveStep(runId, step, { detail = null, status = 'running', now = Date.now } = {}) {
  if (!runId || !step) return
  const entry = ensureEntry(runId, now)
  entry.step = String(step)
  entry.stepDetail = detail && typeof detail === 'object' ? detail : null
  entry.stepTs = now()
  entry.status = status
}

/**
 * Store the latest frame for a run. No-op on missing inputs. Evicts the oldest
 * run when the map grows past MAX_RUNS so a leaked run can never grow memory.
 */
export function putLiveFrame(runId, frame, { status = 'running', now = Date.now } = {}) {
  if (!runId || !frame) return
  const entry = ensureEntry(runId, now)
  entry.frame = String(frame)
  entry.frameTs = now()
  entry.status = status
}

/**
 * The live snapshot for a run: the FRAME (null when absent or STALE — the run is
 * navigating/between-steps/finished, so the UI shows "waiting for the next
 * step" rather than a frozen picture) and the STEP (the play-by-play text,
 * available for much longer than a frame). Returns null only when the run has
 * no entry at all.
 */
export function getLiveFrame(runId, { now = Date.now, ttlMs = FRAME_TTL_MS, stepTtlMs = STEP_TTL_MS } = {}) {
  if (!runId) return null
  const v = store.get(String(runId))
  if (!v) return null
  const frameAge = now() - (v.frameTs || 0)
  const stepAge = now() - (v.stepTs || 0)
  const frameLive = Boolean(v.frame) && frameAge <= ttlMs
  const stepLive = Boolean(v.step) && stepAge <= stepTtlMs
  return {
    frame: frameLive ? v.frame : null,
    frame_age_ms: frameLive ? frameAge : null,
    step: stepLive ? v.step : null,
    step_detail: stepLive ? v.stepDetail : null,
    step_age_ms: stepLive ? stepAge : null,
    status: v.status,
  }
}

export function clearLiveRun(runId) {
  if (runId) store.delete(String(runId))
}

// Test-only: wipe the store between cases.
export function _resetLiveView() {
  store.clear()
}

export function _liveViewSize() {
  return store.size
}

/**
 * Is live view enabled for this deployment? Default ON — the owner asked for it.
 * Only an explicit false/0/off/no disables it.
 */
export function isLiveViewEnabled(env = process.env) {
  const raw = env?.HAMILTON_LIVE_VIEW
  if (raw === undefined || raw === null || raw === '') return true
  return !['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase())
}

/**
 * Attach a CDP screencast to a Playwright page and pump frames into the store
 * under `runId`. Returns `{ stop }`. NEVER throws — a screencast that cannot
 * start simply yields a no-op stop() and the run is unaffected.
 *
 * `createCdpSession` is injectable so the pump can be unit-tested against a fake
 * CDP session without launching Chromium.
 */
export async function startLiveScreencast(page, runId, {
  createCdpSession = null,
  everyNthFrame = 2, // ~ every other frame → a few fps, enough to watch, light on CPU
  quality = 40,
  maxWidth = 900,
  maxHeight = 1600,
  now = Date.now,
} = {}) {
  const noop = { stop: async () => {} }
  if (!page || !runId) return noop

  const mkSession = createCdpSession
    || (async (p) => {
      // Chromium-only; context().newCDPSession(page) is the Playwright API.
      const ctx = typeof p.context === 'function' ? p.context() : null
      if (ctx && typeof ctx.newCDPSession === 'function') return ctx.newCDPSession(p)
      if (typeof p.newCDPSession === 'function') return p.newCDPSession(p)
      throw new Error('no CDP session factory')
    })

  let session = null
  let stopped = false
  try {
    session = await mkSession(page)
    session.on('Page.screencastFrame', (evt) => {
      // Chrome will STOP sending frames until each is acked; ack first, always.
      const sessionId = evt?.sessionId
      if (session && sessionId !== null && sessionId !== undefined) {
        Promise.resolve(session.send('Page.screencastAck', { sessionId })).catch(() => {})
      }
      if (!stopped && evt?.data) {
        try { putLiveFrame(runId, evt.data, { status: 'running', now }) } catch { /* never touch the run */ }
      }
    })
    await session.send('Page.startScreencast', {
      format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame,
    })
  } catch {
    // Live view unavailable for this run; the run proceeds unaffected.
    return {
      stop: async () => { clearLiveRun(runId) },
    }
  }

  return {
    stop: async () => {
      stopped = true
      try { await session?.send('Page.stopScreencast') } catch { /* ignore */ }
      try { session?.removeAllListeners?.('Page.screencastFrame') } catch { /* ignore */ }
      try { await session?.detach?.() } catch { /* ignore */ }
      clearLiveRun(runId)
    },
  }
}
