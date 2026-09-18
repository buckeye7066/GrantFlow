import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { getOwnerAiScope } from './ownerAiScope.js'
const names = ['codex', 'claude']
const digest = x => createHash('sha256').update(x).digest()
export function authenticateWorker(header, env = process.env) {
  const secret = env.OWNER_AI_BRIDGE_TOKEN
  return typeof secret === 'string' && secret.length >= 32 && typeof header === 'string' &&
    header.length <= 1024 && timingSafeEqual(digest(header), digest('Bearer ' + secret))
}
export function createOwnerAiBroker({ env = process.env, now = Date.now } = {}) {
  let worker = null
  let pending = null
  const enabled = () => env.OWNER_AI_BRIDGE_ENABLED === 'true' && typeof env.OWNER_AI_BRIDGE_TOKEN === 'string' && env.OWNER_AI_BRIDGE_TOKEN.length >= 32
  const fresh = () => worker && now() - worker.at < 15000
  const sweep = () => { if (pending && (!enabled() || now() >= pending.deadline)) pending.finish(null) }
  function status() {
    sweep()
    return { enabled: enabled(), online: Boolean(enabled() && fresh()), busy: Boolean(pending), order: names.map(n => 'subscription:' + n),
      providers: Object.fromEntries(names.map(n => [n, enabled() && fresh() ? worker.providers[n] : 'unavailable'])) }
  }
  function poll(body = {}) {
    sweep()
    if (!enabled()) return { job: null }
    worker = { at: now(), providers: Object.fromEntries(names.map(n => [n, ['ready', 'auth_required'].includes(body?.providers?.[n]) ? body.providers[n] : 'unavailable'])) }
    if (body?.active) return { job: null, active: Boolean(pending && pending.id === body.active.id && pending.lease === body.active.lease) }
    if (!pending || pending.lease) return { job: null }
    const providers = names.filter(n => worker.providers[n] === 'ready')
    if (!providers.length) return { job: null }
    pending.providers = providers
    pending.lease = randomBytes(32).toString('hex')
    return { job: { ...pending.input, id: pending.id, lease: pending.lease, providers, timeoutMs: Math.max(0, pending.deadline - now()) } }
  }
  function result(body = {}) {
    sweep()
    if (!pending || !pending.lease || body?.id !== pending.id || body?.lease !== pending.lease) return false
    const r = body.result
    let value = null
    if (r?.ok === true && r.complete === true && r.billing_mode === 'subscription' &&
        pending.providers.some(n => r.provider === 'subscription:' + n) &&
        (r.provider !== 'subscription:codex' || (r.model_source === 'explicit_cli_argument' &&
          ['input_tokens', 'cached_input_tokens'].every(key => Number.isSafeInteger(r.usage?.[key]) && r.usage[key] >= 0))) &&
        typeof r.model === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(r.model) &&
        typeof r.raw === 'string' && r.raw.trim() && Buffer.byteLength(r.raw) <= 262144 &&
        Number.isFinite(r.usage?.output_tokens) && r.usage.output_tokens > 0 && r.usage.output_tokens < pending.input.maxTokens) {
      try {
        value = { ok: true, provider: r.provider, model: r.model, billing_mode: 'subscription', raw: r.raw,
          usage: { output_tokens: r.usage.output_tokens } }
        if (r.provider === 'subscription:codex') {
          value.model_source = 'explicit_cli_argument'
          value.usage.input_tokens = r.usage.input_tokens
          value.usage.cached_input_tokens = r.usage.cached_input_tokens
        }
        if (pending.input.format === 'json') {
          value.json = JSON.parse(r.raw)
          if (!value.json || typeof value.json !== 'object') value = null
        } else value.text = r.raw
      } catch { value = null }
    }
    pending.finish(value)
    return true
  }
  function trySubscription(input = {}) {
    sweep()
    const scope = getOwnerAiScope()
    if (!scope || scope.signal.aborted || !enabled() || !fresh() || !names.some(n => worker.providers[n] === 'ready') || pending ||
        input.signal?.aborted || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 ||
        !['json', 'text'].includes(input.format) || typeof input.prompt !== 'string' ||
        (input.system !== undefined && input.system !== null && typeof input.system !== 'string') ||
        Buffer.byteLength(input.prompt + (input.system || '')) > 131072 ||
        !Number.isInteger(input.maxTokens) || input.maxTokens < 2) return null
    return new Promise(resolve => {
      const signals = [scope.signal, input.signal].filter(Boolean)
      const cancel = () => pending?.finish(null)
      const timer = setTimeout(cancel, Math.min(input.timeoutMs, 120000))
      pending = { id: randomBytes(24).toString('hex'), deadline: now() + Math.min(input.timeoutMs, 120000),
        input: { format: input.format, system: input.system || '', prompt: input.prompt, maxTokens: input.maxTokens },
        finish(value) {
          clearTimeout(timer)
          signals.forEach(s => s.removeEventListener('abort', cancel))
          pending = null
          resolve(value)
        } }
      signals.forEach(s => s.addEventListener('abort', cancel, { once: true }))
      if (signals.some(s => s.aborted)) cancel()
    })
  }
  return { poll, result, status, trySubscription }
}
export const ownerAiBroker = createOwnerAiBroker()
export const tryOwnerSubscription = options => ownerAiBroker.trySubscription(options)
export const getOwnerAiStatus = () => ownerAiBroker.status()
