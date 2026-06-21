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

export default function HamiltonLiveLogin() {
  const navigate = useNavigate()
  const liveSessionId = useQueryParam('session')
  const portalHost = useQueryParam('host')

  const canvasRef = useRef(null)
  const imgRef = useRef(typeof Image !== 'undefined' ? new Image() : null)
  const streamRef = useRef(null)
  const focusedRef = useRef(false)

  const [connected, setConnected] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const [busy, setBusy] = useState(null) // 'complete' | 'cancel' | null
  const [doneMessage, setDoneMessage] = useState(null)
  // Bumping this re-runs the stream effect so a dropped connection can be
  // re-attached WITHOUT restarting the login — the live browser persists
  // server-side (15-min TTL), so reconnecting just resumes the screencast.
  const [reconnectNonce, setReconnectNonce] = useState(0)

  // Draw a base64 JPEG frame onto the canvas, sizing the canvas to the frame's
  // device pixels so coordinate scaling stays 1:1 with what the user sees.
  const drawFrame = useCallback((frame) => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !frame?.data) return
    img.onload = () => {
      const w = frame?.metadata?.deviceWidth || img.naturalWidth
      const h = frame?.metadata?.deviceHeight || img.naturalHeight
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    }
    img.src = `data:image/jpeg;base64,${frame.data}`
  }, [])

  useEffect(() => {
    if (!liveSessionId) {
      setStreamError('missing_session')
      return undefined
    }
    setStreamError(null)
    const handle = streamCloudLogin(liveSessionId, {
      onOpen: () => setConnected(true),
      onFrame: (frame) => drawFrame(frame),
      onError: (reason) => {
        setConnected(false)
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
    setStreamError(null)
    setConnected(false)
    setReconnectNonce((n) => n + 1)
  }, [])

  // Human-readable explanation for the actual stream failure code, so a dead
  // window tells the user (and support) WHAT went wrong instead of a vague
  // "connection ended". The raw code is still shown for diagnostics.
  const explainStreamError = useCallback((code) => {
    const c = String(code || '')
    if (c === 'missing_session') return 'No login session was provided. Start a new secure login from your profile.'
    if (c === 'stream_http_401' || c === 'stream_http_403') {
      return 'Your sign-in to GrantFlow expired in this window. Reconnect to retry, or sign in to GrantFlow again and reopen the login.'
    }
    if (c === 'stream_http_404') return 'The secure login session expired or was closed. Start a new secure login from your profile.'
    if (c === 'stream_unavailable' || c === 'stream_failed') {
      return "The secure browser couldn't start streaming. Reconnect to retry; if it keeps failing, start a new secure login."
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
    sendCloudLoginInput(liveSessionId, event).catch(() => { /* best-effort */ })
  }, [liveSessionId])

  const onMouseEvent = useCallback((type) => (e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    post({ type, x: n.x, y: n.y, button: e.button || 0 })
  }, [normalizedFromEvent, post])

  const onWheel = useCallback((e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    post({ type: 'wheel', x: n.x, y: n.y, deltaX: e.deltaX, deltaY: e.deltaY })
  }, [normalizedFromEvent, post])

  // Touch → tap maps to a click so the page is usable on a phone.
  const onTouch = useCallback((e) => {
    const n = normalizedFromEvent(e)
    if (!n) return
    e.preventDefault()
    post({ type: 'click', x: n.x, y: n.y, button: 0 })
  }, [normalizedFromEvent, post])

  // Keyboard: send keydown (with key/code) and, for printable chars, a char
  // event so typed text lands in the page's focused field.
  const onKeyDown = useCallback((e) => {
    if (!focusedRef.current) return
    // Don't hijack browser refresh / devtools.
    if ((e.ctrlKey || e.metaKey) && ['r', 'R'].includes(e.key)) return
    e.preventDefault()
    post({ type: 'keydown', key: e.key, code: e.code, keyCode: e.keyCode })
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      post({ type: 'char', key: e.key, text: e.key })
    }
  }, [post])

  const onKeyUp = useCallback((e) => {
    if (!focusedRef.current) return
    e.preventDefault()
    post({ type: 'keyup', key: e.key, code: e.code, keyCode: e.keyCode })
  }, [post])

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onKeyDown, onKeyUp])

  const handleDone = useCallback(async () => {
    if (!liveSessionId || busy) return
    setBusy('complete')
    try {
      await completeCloudLogin(liveSessionId)
      try { streamRef.current?.close() } catch { /* ignore */ }
      setDoneMessage('Session captured — Hamilton can now act inside this portal for this profile. You can close this window.')
    } catch (err) {
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
              only — never your password or 2FA code. The window expires in 15 minutes.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-slate-400">
            {connected ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-amber-400" />}
            {connected ? 'Live' : 'Connecting…'}
          </span>
          <Button size="sm" disabled={busy === 'complete'} onClick={handleDone}>
            {busy === 'complete' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1.5 h-4 w-4" />}
            Done — I&apos;ve finished logging in
          </Button>
          <Button size="sm" variant="ghost" disabled={busy === 'cancel'} onClick={handleCancel}>
            <X className="mr-1.5 h-4 w-4" /> Cancel
          </Button>
        </div>
      </div>

      {/* Live viewport */}
      <div className="relative flex flex-1 items-center justify-center overflow-auto p-2 sm:p-4">
        {!connected && !streamError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Opening your secure login window…</p>
          </div>
        )}
        {streamError && !connected && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-slate-300">
            <WifiOff className="h-8 w-8 text-amber-400" />
            <p className="max-w-md text-sm">{explainStreamError(streamError)}</p>
            <p className="text-xs text-slate-500">Details: {String(streamError)}</p>
            <div className="mt-2 flex items-center gap-2">
              {streamError !== 'missing_session' && (
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
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onMouseDown={onMouseEvent('mousedown')}
          onMouseUp={onMouseEvent('mouseup')}
          onMouseMove={onMouseEvent('mousemove')}
          onClick={onMouseEvent('click')}
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
