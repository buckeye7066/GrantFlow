/**
 * liveLoginWindow — open the Hamilton secure live-login popup correctly.
 *
 * THE BUG THIS FIXES (permanently + globally): the cloud-login popup used to be
 * opened inside a mutation's async `onSuccess`, i.e. AFTER `await
 * startCloudLogin(...)`. But that backend call launches a real headless Chromium
 * and navigates to the portal before it responds, so by the time `window.open`
 * ran it was no longer a user-initiated action. Browsers then either blocked the
 * popup (and the old code ignored the null return, falsely toasting "opened") or
 * opened a blank about:blank that never navigated — a DEAD WINDOW.
 *
 * THE FIX: open the popup SYNCHRONOUSLY in the click handler, while the user
 * gesture is still live, with `window.open('', '_blank')` (no "noopener" — that
 * makes window.open return null AND would sever window.opener, which the
 * /HamiltonLiveLogin page needs to self-close). We paint a friendly "Preparing…"
 * placeholder, then redirect the window once the async start resolves. On
 * failure we render an error in the same window instead of leaving it dead.
 *
 * USAGE (every cloud-login call site must follow this shape):
 *
 *   const popup = openPendingLoginWindow()
 *   if (popup.blocked) { showErrorToast(...allow pop-ups...); return }
 *   myMutation.mutate({ ...vars, popup })
 *   // onSuccess(res, { popup }) → popup.navigate(resolveLiveLoginUrl(res))
 *   // onError(err,  { popup }) → popup.fail(err?.message)
 */

const NOOP_HANDLE = {
  blocked: false,
  navigate() {},
  fail() {},
  close() {},
}

function loadingHtml(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; }
  body { display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:18px; background:#0f172a; color:#e2e8f0;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .spinner { width:42px; height:42px; border-radius:50%;
             border:4px solid rgba(148,163,184,.25); border-top-color:#34d399;
             animation:spin 0.9s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation:none; } }
  p { margin:0; font-size:15px; }
  small { color:#94a3b8; font-size:12.5px; max-width:22rem; text-align:center; }
</style></head>
<body>
  <div class="spinner" role="status" aria-label="Loading"></div>
  <p>Preparing your secure login&hellip;</p>
  <small>Keep this window open. It will load the portal sign-in page in a moment.</small>
</body></html>`
}

function errorHtml(message) {
  const safe = String(message || "Something went wrong starting the secure login.")
    .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Secure login</title>
<style>
  :root { color-scheme: dark; }
  html,body { height:100%; margin:0; }
  body { display:flex; flex-direction:column; align-items:center; justify-content:center;
         gap:14px; background:#0f172a; color:#e2e8f0; padding:24px; box-sizing:border-box;
         font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .x { width:42px; height:42px; border-radius:50%; background:rgba(248,113,113,.15);
       color:#f87171; display:flex; align-items:center; justify-content:center;
       font-size:24px; font-weight:700; }
  p { margin:0; font-size:15px; text-align:center; max-width:26rem; }
  small { color:#94a3b8; font-size:12.5px; text-align:center; }
  button { margin-top:8px; padding:8px 16px; border-radius:10px; border:1px solid #334155;
           background:transparent; color:#e2e8f0; font-size:13px; cursor:pointer; }
</style></head>
<body>
  <div class="x" aria-hidden="true">!</div>
  <p>${safe}</p>
  <small>You can close this window and try again from GrantFlow.</small>
  <button type="button" onclick="window.close()">Close</button>
</body></html>`
}

/**
 * Open the secure-login popup synchronously. MUST be called directly inside a
 * user-gesture handler (a click), NOT after an await — otherwise the browser
 * blocks it. Returns a handle:
 *   - blocked      true when the browser refused to open the popup at all
 *   - navigate(url) redirect the popup to the live-login page once it's ready
 *   - fail(message) replace the placeholder with a readable error
 *   - close()      close the popup
 */
export function openPendingLoginWindow({ title = "Secure login" } = {}) {
  if (typeof window === "undefined") return NOOP_HANDLE

  let win = null
  try {
    // No features string / no "noopener": we need a real handle to navigate it,
    // and the live-login page self-closes via window.opener.
    win = window.open("", "_blank")
  } catch {
    win = null
  }
  if (!win) return { ...NOOP_HANDLE, blocked: true }

  try {
    win.document.open()
    win.document.write(loadingHtml(title))
    win.document.close()
  } catch {
    /* timing/cross-process write race — navigate() below still works */
  }

  return {
    blocked: false,
    navigate(url) {
      if (!url) {
        this.fail("We couldn't build your secure login link. Please try again.")
        return
      }
      try {
        win.location.replace(url)
      } catch {
        try { win.location.href = url } catch { /* give up quietly */ }
      }
    },
    fail(message) {
      try {
        win.document.open()
        win.document.write(errorHtml(message))
        win.document.close()
      } catch {
        try { win.close() } catch { /* ignore */ }
      }
    },
    close() {
      try { win.close() } catch { /* ignore */ }
    },
  }
}

/**
 * Resolve the URL the popup should navigate to from a startCloudLogin response.
 * Prefer the backend-built absolute liveUrl; otherwise build the same-origin
 * /HamiltonLiveLogin route from the returned session id. Returns null when the
 * response carries neither (caller should treat that as a failure).
 */
export function resolveLiveLoginUrl(res) {
  if (res?.liveUrl) return res.liveUrl
  const sessionId = res?.liveSessionId || res?.id
  if (!sessionId) return null
  const params = new URLSearchParams({ session: sessionId })
  if (res?.portalHost) params.set("host", res.portalHost)
  return `/HamiltonLiveLogin?${params.toString()}`
}
