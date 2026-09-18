import { AsyncLocalStorage } from 'node:async_hooks'
import { isReservedSyntheticUserId } from '../../middleware/syntheticServiceTokens.js'
const scopes = new AsyncLocalStorage()
export function isCanonicalOwner(req) {
  const c = req?.ctx
  const email = (process.env.AGENT_CONTROL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  return Boolean(c?.identityResolved === true && c.isAdmin === true &&
    typeof c.userId === 'string' && c.userId.trim() && !isReservedSyntheticUserId(c.userId) &&
    email && c.email === email && (!process.env.OWNER_AI_USER_ID || c.userId === process.env.OWNER_AI_USER_ID) &&
    ![req, req?.user, c].some(x => x?.serviceToken || x?.profileTokenAuth))
}
export function getOwnerAiScope({ includeAborted = false } = {}) {
  const scope = scopes.getStore()
  return scope && (includeAborted || !scope.signal.aborted) ? scope : null
}
export function runWithOwnerAiScope(req, work) {
  if (!isCanonicalOwner(req) || !req.res?.once) return scopes.run(null, work)
  if (req.res.destroyed || req.res.writableEnded) return
  const controller = new AbortController()
  const close = () => { controller.abort(); req.res.removeListener('close', close); req.res.removeListener('finish', close) }
  req.res.once('close', close)
  req.res.once('finish', close)
  return scopes.run({ signal: controller.signal }, work)
}


// Capture authority before acknowledging a user-requested background job.
// Its own bounded lifetime, not the completed HTTP response, owns cancellation.
export function captureOwnerAiJobScope(req, { timeoutMs = 240000 } = {}) {
  const owner = isCanonicalOwner(req)
  if (owner && (req.res?.destroyed || req.res?.writableEnded)) throw new Error('Cannot start owner job from a completed request')
  const controller = new AbortController()
  const numeric = Number(timeoutMs)
  const budget = Number.isFinite(numeric) ? Math.max(1, Math.min(240000, numeric)) : 240000
  let started = false
  return {
    owner,
    cancel: () => controller.abort(),
    async run(work) {
      if (started) throw new Error('Owner job scope is single-use')
      started = true
      const timer = setTimeout(() => controller.abort(), budget)
      try {
        controller.signal.throwIfAborted()
        return await scopes.run(owner ? { signal: controller.signal } : null, work)
      } finally { clearTimeout(timer); controller.abort() }
    },
  }
}
