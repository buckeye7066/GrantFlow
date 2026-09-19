import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getJwtSecretOrThrow } from '../../config/env.js'
import { isReservedSyntheticUserId } from '../../middleware/syntheticServiceTokens.js'
const scopes = new AsyncLocalStorage()
export function isCanonicalOwner(req) {
  const c = req?.ctx
  // Bind subscriptions to one real owner account without changing global admin permissions.
  const ownerEmail = (process.env.OWNER_AI_EMAIL || '').trim()
  const email = (ownerEmail || process.env.AGENT_CONTROL_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase()
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
  return scopes.run({ signal: controller.signal, identity: {userId:req.ctx.userId,email:req.ctx.email} }, work)
}


// Capture authority before acknowledging a user-requested background job.
// Its own bounded lifetime, not the completed HTTP response, owns cancellation.
export function captureOwnerAiJobScope(req, { timeoutMs = 240000 } = {}) {
  const owner = isCanonicalOwner(req)
  if (owner && (req.res?.destroyed || req.res?.writableEnded)) throw new Error('Cannot start owner job from a completed request')
  const controller = new AbortController()
  const numeric = Number(timeoutMs)
  const budget = ownerAiJobBudget(numeric)
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
        return await scopes.run(owner ? { signal: controller.signal, identity: {userId:req.ctx.userId,email:req.ctx.email} } : null, work)
      } finally { clearTimeout(timer); controller.abort() }
    },
  }
}

// Capture only the server-established owner scope at an explicit queue boundary.
// Queue bookkeeping remains neutral; each actual handler gets its own deadline.
export function captureDetachedOwnerAiRunner() {
  const inherited = scopes.getStore()
  const alreadyAborted = inherited?.signal.aborted === true
  return async (work, { timeoutMs = 240000, signal, waitForSettlement = false } = {}) => {
    if (alreadyAborted) throw inherited.signal.reason || new Error('Owner request already aborted')
    const duration = Number(timeoutMs)
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('A bounded job timeout is required')
    const controller = new AbortController()
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Job time budget exhausted'),{name:'AbortError',code:'JOB_TIMEOUT'})), Math.min(duration, 21600000))
    let onAbort
    let underlying
    try {
      active.throwIfAborted()
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(active.reason || new DOMException('Job aborted', 'AbortError'))
        active.addEventListener('abort', onAbort, {once:true})
      })
      return await scopes.run(inherited ? {...inherited,signal:active} : null, () => {
        underlying = new Promise(resolve => {active.throwIfAborted();resolve(work(active))})
        return Promise.race([aborted, underlying])
      })
    } finally {
      // A code-editing phase owns exclusion until it really stops, not merely
      // until its timeout response settles. Other queued work retains fast abort.
      if (waitForSettlement && underlying) await underlying.catch(() => {})
      clearTimeout(timeout)
      if (onAbort) active.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}

export function runWithoutOwnerAiScope(work) { return scopes.run(null, work) }


export function ownerAiJobBudget(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.min(21600000, numeric)) : 240000
}
const DURABLE_OWNER_KEY = '_owner_ai'
function ownerProofPayload(job,identity) {
  return JSON.stringify({v:1,id:String(job.id),type:String(job.type),profileId:job.profile_id ?? null,userId:identity.userId,email:identity.email})
}
function ownerProofSignature(payload) {
  const key = getJwtSecretOrThrow(process.env)
  // The canonical resolver already enforces the deployment secret policy.
  return createHmac('sha256',key).update('grantflow-owner-job-v1\n'+payload).digest('hex')
}
export function ownerAiJobParameters(parameters,job) {
  const clean = {...parameters}
  delete clean[DURABLE_OWNER_KEY]
  const scope = getOwnerAiScope({includeAborted:true})
  if (!scope) return clean
  scope.signal.throwIfAborted()
  if (!scope.identity?.userId || !scope.identity?.email) throw new Error('Owner queue identity is unavailable')
  const payload = ownerProofPayload(job,scope.identity)
  clean[DURABLE_OWNER_KEY] = {identity:{...scope.identity},signature:ownerProofSignature(payload)}
  return clean
}
export async function durableOwnerAiRunner(job, db) {
  const parameters = typeof job.parameters === 'string' ? JSON.parse(job.parameters) : job.parameters
  const proof = parameters?.[DURABLE_OWNER_KEY]
  if (proof === undefined) return null
  const identity = proof?.identity
  if (!identity || typeof proof.signature !== 'string' || !/^[a-f0-9]{64}$/.test(proof.signature)) throw new Error('Invalid durable owner AI policy')
  const expected = ownerProofSignature(ownerProofPayload(job,identity))
  const req = {ctx:{identityResolved:true,isAdmin:true,userId:identity.userId,email:identity.email}}
  if (!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(proof.signature,'hex')) || !isCanonicalOwner(req)) throw new Error('Invalid or revoked durable owner AI policy')
  // A signature proves who queued it, not that an account remains authorized.
  const ctx = await verifiedOwnerContext(db, { userId: identity.userId })
  if (!isCanonicalOwner({ ctx }) || ctx.email !== identity.email) throw new Error('Revoked durable owner AI policy')
  return scopes.run({identity:{userId:ctx.userId,email:ctx.email},signal:new AbortController().signal},captureDetachedOwnerAiRunner)
}


export async function ownerAiRetryParameters(parameters,nextJob,originalJob,db) {
  const restore = await durableOwnerAiRunner(originalJob,db)
  if (!restore) return runWithoutOwnerAiScope(() => ownerAiJobParameters(parameters,nextJob))
  return restore(() => ownerAiJobParameters(parameters,nextJob),{timeoutMs:1000})
}

// Use the canonical database-backed authority resolver at cold-login boundaries.
async function verifiedOwnerContext(db, user) {
  if (!db?.prepare) throw new Error('Owner policy requires database identity verification')
  const { buildRequestContext } = await import('../../middleware/requestContext.js')
  return buildRequestContext(db, user)
}
export async function runWithVerifiedOwnerAiScope(db, user, work) {
  const ctx = await verifiedOwnerContext(db, user)
  if (!isCanonicalOwner({ ctx, user })) return runWithoutOwnerAiScope(work)
  const runner = scopes.run({ identity: {userId:ctx.userId,email:ctx.email}, signal: new AbortController().signal }, captureDetachedOwnerAiRunner)
  return runner(work, { timeoutMs: 240000 })
}
// Internal billing provenance never belongs in API responses, even for admins.
export function publicOwnerAiParameters(parameters) {
  const parsed = typeof parameters === 'string' ? JSON.parse(parameters) : parameters
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed ?? null
  const copy = {...parsed}
  delete copy[DURABLE_OWNER_KEY]
  return copy
}
