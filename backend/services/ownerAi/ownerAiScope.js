import { AsyncLocalStorage } from 'node:async_hooks'
import { isReservedSyntheticUserId } from '../../middleware/syntheticServiceTokens.js'
const scopes = new AsyncLocalStorage()
export function isCanonicalOwner(req) {
  const c = req?.ctx
  const email = process.env.AGENT_CONTROL_ADMIN_EMAIL || process.env.ADMIN_EMAIL
  return Boolean(c?.identityResolved === true && c.isAdmin === true &&
    typeof c.userId === 'string' && c.userId.trim() && !isReservedSyntheticUserId(c.userId) &&
    email && c.email === email && (!process.env.OWNER_AI_USER_ID || c.userId === process.env.OWNER_AI_USER_ID) &&
    ![req, req?.user, c].some(x => x?.serviceToken || x?.profileTokenAuth))
}
export function getOwnerAiScope() {
  const scope = scopes.getStore()
  return scope && !scope.signal.aborted ? scope : null
}
export function runWithOwnerAiScope(req, work) {
  if (!isCanonicalOwner(req) || !req.res?.once || req.res.destroyed || req.res.writableEnded) return scopes.run(null, work)
  const controller = new AbortController()
  const close = () => { controller.abort(); req.res.removeListener('close', close); req.res.removeListener('finish', close) }
  req.res.once('close', close)
  req.res.once('finish', close)
  return scopes.run({ signal: controller.signal }, work)
}
