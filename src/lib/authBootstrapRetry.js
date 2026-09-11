/**
 * Auth bootstrap retry policy.
 *
 * GET /api/auth/me decides whether the SPA renders the workspace or the sign-in
 * page. A rate limit (429) or a server fault (5xx) says nothing about whether the
 * session is valid, so it must never be treated as "signed out". Production
 * 2026-09-11: an exhausted per-principal read bucket answered 429 with
 * retry_after_seconds=399 and App cleared a valid admin session, rendering
 * "Sign in to GrantFlow" on every route.
 */
export function isTransientAuthCheckError(error) {
  const status = Number(error?.status)
  if (!Number.isFinite(status)) return false
  if (status === 429) return true
  return status >= 500 && status <= 599 && status !== 501
}

/** Seconds to wait before re-checking: the server's hint, clamped to 1..60. */
export function authCheckRetryDelaySeconds(error) {
  const hinted = Number(error?.details?.retry_after_seconds ?? error?.retryAfterSeconds)
  const seconds = Number.isFinite(hinted) && hinted > 0 ? Math.ceil(hinted) : 5
  return Math.min(60, Math.max(1, seconds))
}
