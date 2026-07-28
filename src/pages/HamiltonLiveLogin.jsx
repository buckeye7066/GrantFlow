/**
 * HamiltonLiveLogin — the friendly, full-screen live login window.
 *
 * Opened from the Portal Sessions card after a cloud login starts. It shows a
 * live mirror of a real browser sitting on the portal's login page: the user
 * types their username/password and approves 2FA (e.g. a Microsoft/Duo push on
 * their phone), watches the page update live, then clicks "Done — I've finished
 * logging in" so Hamilton captures the authenticated session.
 *
 * How it works (single public port, proxy-friendly, dependency-free):
 *   - The page is mirrored frame-by-frame over an SSE stream
 *     (GET .../cloud-login/:id/stream) — each frame is a base64 JPEG we draw
 *     onto a <canvas>.
 *   - The user's mouse / wheel / keyboard are captured here and POSTed one event
 *     at a time (.../cloud-login/:id/input) with NORMALIZED coordinates (0..1 of
 *     the displayed image); the server scales them to the real page.
 *   - "Done" calls complete (captures + imports the session); "Cancel" tears the
 *     live browser down.
 *
 * This is NOT the Chromium DevTools inspector — it's a clean, large viewport with
 * minimal chrome, usable on a phone (a tap maps to a click).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { streamCloudLogin, sendCloudLoginInput, completeCloudLogin, cancelCloudLogin } from '@/api/hamilton'
import { Button } from '@/components/ui/button'
import { Loader2, ShieldCheck, X, Smartphone, Wifi, WifiOff } from 'lucide-react'

function useQueryParam(name) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  return params.get(name)
}

// CDP Input.* modifier bitmask (Alt=1, Ctrl=2, Meta/Command=4, Shift=8) from a
// DOM mouse/keyboard/touch event, so shift-click, ctrl+A, shift-Tab etc. reach
// the live page instead of arriving unmodified.
function cdpModifiers(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

export default function HamiltonLiveLogin() {
  const navigate = useNavigate()
  const liveSessionId = useQueryParam('session')
  const portalHost = useQueryParam('host')

  const canvasRef = useRef(null)
  const imgRef = useRef(typeof Image !== 'undefined' ? new Image() : null)
  const streamRef = useRef(null)
  const focusedRef = useRef(false)
  const paintedRef = useRef(false)

  const [connected, setConnected] = useState(false)
  // Whether at least one frame has actually been PAINTED to the canvas. The SSE
  // stream can be "connected" (HTTP open) while zero frames have drawn, so this
  // — not `connected` — drives the "Live" indicator and dismisses the loading
  // overlay. Without it a blank white canvas would falsely read as "Live".
  const [painted, setPainted] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const [busy, setBusy] = useState(null) // 'complete' | 'cancel' | null
  const [doneMessage, setDoneMessage] = useState(null)
  // Non-fatal Done failures — the live session is still alive server-side, so
  // these render as a retry strip, NOT as the stream-failure overlay:
  //   { kind: 'not_verified' | 'import_failed', message }
  const [completeIssue, setCompleteIssue] = useState(null)
  // Bumping this re-runs the stream effect so a dropped connection can be
  // re-attached WITHOUT restarting the login — the live browser persists
  // server-side (15-min TTL), so reconnecting just resumes the screencast.
  const [reconnectNonce, setReconnectNonce] = useState(0)

  // Input-channel health. The screencast (one long-lived authenticated GET) and
  // the input relay (one authenticated POST per event) have SEPARATE lifecycles:
  // the stream can keep painting (or the canvas keep its last frame) while every
  // input POST dies. Swallowing those failures produced the reported bug — a
  // live-looking portal where "no matter what I click, it doesn't work". Track
  // failures here and surface them through the SAME error/reconnect UI the
  // stream uses. sessionDeadRef gates further posts once the session is gone.
  const sessionDeadRef = useRef(false)
  const inputFailStreakRef = useRef(0)

  // Draw a base64 JPEG frame onto the canvas, sizing the canvas to the frame's
  // device pixels so coordinate scaling stays 1:1 with what the user sees.
  const drawFrame = useCallback((frame) => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !frame?.data) return
    img.onload = () => {
      const w = frame?.metadata?.deviceWidth || img.naturalWidth
      const h = frame?.metadata?.deviceHeight || img.naturalHeight
      if (w && canvas.width !== w) canvas.width = w
      if (h && canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        if (!paintedRef.current) { paintedRef.current = true; setPainted(true) }
      }
    }
    img.src = `data:image/jpeg;base64,${frame.data}`
  }, [])

  useEffect(() => {
    if (!liveSessionId) {
      setStreamError('missing_session')
      return undefined
    }
    setStreamError(null)
    paintedRef.current = false
    setPainted(false)
    const handle = streamCloudLogin(liveSessionId, {
      onOpen: () => setConnected(true),
      onFrame: (frame) => drawFrame(frame),
      onError: (reason) => {
        setConnected(false)
        // The server now announces teardown ('session_closed') instead of
        // leaving the stream heartbeat-alive over a dead session; a 404 on
        // (re)connect means the same thing. Gate further input posts.
        const r = String(reason || '')
        if (r === 'session_closed' || r === 'stream_http_404') sessionDeadRef.current = true
        // 'stream_ended' after a successful complete is expected; don't alarm.
        setStreamError((prev) => prev || reason)
      },
    })
    streamRef.current = handle
    return () => {
      try { handle.close() } catch { /* ignore */ }
      streamRef.current = null
    }
  }, [liveSessionId, drawFrame, reconnectNonce])

  const handleReconnect = useCallback(() => {
    sessionDeadRef.current = false
    inputFailStreakRef.current = 0
    setStreamError(null)
    setConnected(false)
    setReconnectNonce((n) => n + 1)
  }, [])

  // Errors that no reconnect can fix: the server-side live session no longer
  // exists (expired / completed / cancelled / backend restarted). The only
  // honest recovery is starting a new secure login from the profile.
  const isTerminalError = useCallback((code) => {
    const c = String(code || '')
    return c === 'missing_session' || c === 'session_gone' || c === 'session_closed' || c === 'stream_http_404'
  }, [])

  // Human-readable explanation for the actual stream failure code, so a dead
  // window tells the user (and support) WHAT went wrong instead of a vague
  // "connection ended". The raw code is still shown for diagnostics.
  const explainStreamError = useCallback((code) => {
    const c = String(code || '')
    if (c === 'missing_session') return 'No login session was provided. Start a new secure login from your profile.'
    if (c === 'stream_http_401' || c === 'stream_http_403' || c === 'input_http_401' || c === 'input_http_403') {
      return 'Your sign-in to GrantFlow expired in this window. Reconnect to retry, or sign in to GrantFlow again and reopen the login.'
    }
    if (c === 'stream_http_404' || c === 'session_gone' || c === 'session_closed') {
      return 'The secure login session expired or was closed. Close this window and start a new secure login from your profile.'
    }
    if (c === 'stream_unavailable' || c === 'stream_failed') {
      return "The secure browser couldn't start streaming. Reconnect to retry; if it keeps failing, start a new secure login."
    }
    if (c === 'input_failed') {
      return "The live page stopped accepting your clicks and typing. Reconnect to retry; if it keeps failing, start a new secure login."
    }
    return 'The live connection ended. If you had already finished logging in, your session may be captured — otherwise reconnect or start a new secure login.'
  }, [])

  // Translate a DOM pointer/mouse event to normalized 0..1 coords over the
  // displayed canvas, then POST it. Out-of-bounds events are ignored.
  const normalizedFromEvent = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const clientX = e.touches?.[0]?.clientX ?? e.clientX
    const clientY = e.touches?.[0]?.clientY ?? e.clientY
    if (typeof clientX !== 'number' || typeof clientY !== 'number') return null
    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
  }, [])

  const post = useCallback((event) => {
    if (!liveSessionId || !event) return
    // Once the server told us the session is gone, stop spamming a dead id.
    if (sessionDeadRef.current) return
    sendCloudLoginInput(liveSessionId, event)
      .then(() => { inputFailStreakRef.current = 0 })
      .catch((err) => {
        // These failures were silently swallowed ("best-effort"), which made a
        // dead/unauthorized session look like a live portal that ignores every
        // click. Classify and surface them instead.
        const status = err?.status
        const code = err?.errorCode || err?.details?.reason || ''
        if (status === 404 || code === 'not_found_or_expired') {
          sessionDeadRef.current = true
          setConnected(false)
          setStreamError((prev) => prev || 'session_gone')
          return
        }
        if (status === 401 || status === 403) {
          // apiFetch already refresh-retried internally; a hard auth failure
          // here means this window's GrantFlow session is dead.
          setConnected(false)
          setStreamError((prev) => prev || `input_http_${status}`)
          return
        }
        inputFailStreakRef.current += 1
        // A lone blip (one dropped POST) shouldn't alarm; a streak means the
        // input channel is really down while the mirror may still look alive.
        if (inputFailStreakRef.current >= 3) {
          setStreamError((prev) => prev || 'input_failed')
        }
      })
  }, [liveSessionId])

  const onMouseEvent = useCallback((type) => (e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    post({ type, x: n.x, y: n.y, button: e.button || 0, modifiers: cdpModifiers(e) })
  }, [normalizedFromEvent, post])

  const onWheel = useCallback((e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    post({ type: 'wheel', x: n.x, y: n.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: cdpModifiers(e) })
  }, [normalizedFromEvent, post])

  // Touch → tap maps to a synthetic 'click' (the backend expands it into
  // move+press+release) so the page is usable on a phone. Desktop clicks ride
  // the separate mousedown/mouseup relays instead — see the canvas handlers.
  const onTouch = useCallback((e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    e.preventDefault()
    post({ type: 'click', x: n.x, y: n.y, button: 0, modifiers: cdpModifiers(e) })
  }, [normalizedFromEvent, post])

  // Keyboard: send keydown (with key/code) and, for printable chars, a char
  // event so typed text lands in the page's focused field. The CDP modifier
  // bitmask rides along so ctrl/shift shortcuts work inside the portal.
  const onKeyDown = useCallback((e) => {
    if (!focusedRef.current) return
    // Don't hijack browser refresh / devtools.
    if ((e.ctrlKey || e.metaKey) && ['r', 'R'].includes(e.key)) return
    e.preventDefault()
    post({ type: 'keydown', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) })
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      post({ type: 'char', key: e.key, text: e.key, modifiers: cdpModifiers(e) })
    }
  }, [post])

  const onKeyUp = useCallback((e) => {
    if (!focusedRef.current) return
    e.preventDefault()
    post({ type: 'keyup', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: cdpModifiers(e) })
  }, [post])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onKeyDown, onKeyUp])

  // `force` overrules the server's visible-password-field heuristic after it
  // refused with 'login_not_verified' (a heuristic, not proof — the user may
  // know the portal simply keeps a password box on screen).
  const handleDone = useCallback(async ({ force = false } = {}) => {
    if (!liveSessionId || busy) return
    setBusy('complete')
    setCompleteIssue(null)
    try {
      await completeCloudLogin(liveSessionId, { force })
      try { streamRef.current?.close() } catch { /* ignore */ }
      setDoneMessage('Session captured — Hamilton can now act inside this portal for this profile. You can close this window.')
    } catch (err) {
      const reason = err?.details?.reason || err?.errorCode || ''
      if (reason === 'login_not_verified') {
        // The live session is untouched — offer a force retry.
        setCompleteIssue({
          kind: 'not_verified',
          message: err?.details?.detail || 'The portal still shows a password field — finish logging in first.',
        })
        setBusy(null)
        return
      }
      if (err?.errorCode === 'import_failed' || err?.details?.retryable === true) {
        // Capture succeeded but the DB write failed; the live login is still
        // alive server-side, so Done can simply be clicked again.
        setCompleteIssue({
          kind: 'import_failed',
          message: 'Saving the captured session failed — your login is still live. Click Done again to retry.',
        })
        setBusy(null)
        return
      }
      setStreamError(err?.message || 'complete_failed')
      setBusy(null)
    }
  }, [liveSessionId, busy])

  const handleCancel = useCallback(async () => {
    if (!liveSessionId || busy) return
    setBusy('cancel')
    try { await cancelCloudLogin(liveSessionId) } catch { /* best-effort */ }
    try { streamRef.current?.close() } catch { /* ignore */ }
    if (window.opener) { window.close() } else { navigate('/MyProfiles') }
  }, [liveSessionId, busy, navigate])

  if (doneMessage) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-6 text-center text-slate-100">
        <ShieldCheck className="mb-3 h-10 w-10 text-emerald-400" />
        <p className="max-w-md text-base">{doneMessage}</p>
        <Button className="mt-6" onClick={() => { if (window.opener) window.close(); else navigate('/MyProfiles') }}>
          Close
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-slate-100">
      {/* Instruction banner + actions */}
      <div className="flex flex-col gap-3 border-b border-slate-700 bg-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          <div>
            <p className="text-sm font-medium">
              Sign in{portalHost ? ` to ${portalHost}` : ''} right here on this device, then click Done.
            </p>
            <p className="text-xs text-slate-400">
              You are driving a real, private browser <span className="font-medium text-slate-300">on this laptop</span> — type
              the username &amp; password and complete 2FA in this window. Only a phone-<em>push</em> 2FA (Duo / Microsoft
              Authenticator) needs the phone; a texted or app code can be entered here. We capture the logged-in session
              only — never your password or 2FA code. The window expires after 15 minutes of inactivity (60 minutes maximum).
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-slate-400">
            {connected && painted ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-amber-400" />}
            {connected && painted ? 'Live' : painted ? 'Reconnecting…' : 'Connecting…'}
          </span>
          {/* Done is gated on a genuinely LIVE view (connected + painted + no
              stream error): completing against a window that never painted or
              whose session died would capture a jar the user never saw. The
              title (on a wrapper span — disabled buttons swallow hover) says
              why it's disabled. */}
          <span
            title={
              connected && painted && !streamError
                ? undefined
                : 'Done unlocks once the live portal view is connected and showing — wait for "Live" (or reconnect) first.'
            }
          >
            <Button
              size="sm"
              disabled={busy === 'complete' || !(connected && painted && !streamError)}
              onClick={() => handleDone()}
            >
              {busy === 'complete' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
              Done — I&apos;ve finished logging in
            </Button>
          </span>
          <Button size="sm" variant="ghost" disabled={busy === 'cancel'} onClick={handleCancel}>
            <X className="mr-1.5 h-4 w-4" /> Cancel
          </Button>
        </div>
      </div>

      {/* Non-fatal Done failure strip: the live session is still alive, so this
          offers a retry (and, for the login-not-verified heuristic, an explicit
          "Force save anyway") instead of the dead-stream overlay. */}
      {completeIssue && (
        <div className="flex flex-col gap-2 border-b border-amber-600/40 bg-amber-950/40 px-4 py-2 text-xs text-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <span>{completeIssue.message}</span>
          <div className="flex shrink-0 items-center gap-2">
            {completeIssue.kind === 'not_verified' && (
              <Button size="sm" variant="secondary" disabled={busy === 'complete'} onClick={() => handleDone({ force: true })}>
                Force save anyway
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCompleteIssue(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Live viewport */}
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-2 sm:p-4">
        {!painted && !streamError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">{connected ? 'Loading the live view…' : 'Opening your secure login window…'}</p>
          </div>
        )}
        {/* Failure overlay. Rendered whether or not a frame ever painted: a
            painted canvas whose session/input channel died is a live-LOOKING
            portal that silently ignores every click (the reported bug), so the
            last frame is dimmed behind an explicit message + recovery actions
            instead of masquerading as a working page. */}
        {streamError && (
          <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center text-slate-300 ${painted ? 'bg-slate-900/80' : ''}`}>
            <WifiOff className="h-8 w-8 text-amber-400" />
            <p className="max-w-md text-sm">{explainStreamError(streamError)}</p>
            <p className="text-xs text-slate-500">Details: {String(streamError)}</p>
            <div className="mt-2 flex items-center gap-2">
              {!isTerminalError(streamError) && (
                <Button size="sm" onClick={handleReconnect}>
                  <Wifi className="mr-1.5 h-4 w-4" /> Reconnect
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => { if (window.opener) window.close(); else navigate('/MyProfiles') }}>
                Close
              </Button>
            </div>
          </div>
        )}
        {/* NO onClick relay on the canvas: the browser fires click AFTER
            mousedown+mouseup, and the backend expands 'click' into
            move+press+release — so relaying it too made every physical click a
            DOUBLE click at the portal (checkboxes toggled back off, double form
            submits). The synthetic 'click' stays reserved for the touch path
            (onTouchStart), which posts it as the whole tap. */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onMouseDown={onMouseEvent('mousedown')}
          onMouseUp={onMouseEvent('mouseup')}
          onMouseMove={onMouseEvent('mousemove')}
          onWheel={onWheel}
          onTouchStart={onTouch}
          onFocus={() => { focusedRef.current = true }}
          onBlur={() => { focusedRef.current = false }}
          className="max-h-full max-w-full cursor-pointer rounded-md bg-white shadow-2xl outline-none ring-2 ring-transparent focus:ring-emerald-500"
          style={{ touchAction: 'none' }}
        />
      </div>
    </div>
  )
}
