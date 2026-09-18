import { createHash } from 'node:crypto'
import { createLogger } from './logger.js'
const configLog = createLogger('utils:paidAiRoutes')
const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const adaptiveModels = new Set(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'])

const sharedState = new Map()
export function resetPaidAiCircuitState() { sharedState.clear() }
export function paidCircuitState() { return sharedState }

// Configuration is server-only. Never accept route URLs or credentials from invocation options.
export function resolvePaidAiRoutes({ openai, openaiModel, anthropicModel }) {
  const defaults = [
    { provider: 'openai', model: openaiModel || process.env.OPENAI_MODEL || process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini' },
    { provider: 'anthropic', model: anthropicModel || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5' },
  ]
  let entries = defaults
  if (process.env.AI_PAID_ROUTES !== undefined) {
    try { entries = JSON.parse(process.env.AI_PAID_ROUTES) } catch { entries = [] }
  }
  if (!Array.isArray(entries)) entries = []
  const parse = candidates => candidates.slice(0, 24).flatMap(entry => {
    if (!entry || !['openai', 'anthropic', 'compatible'].includes(entry.provider)) return []
    const { provider, model } = entry
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(model)) return []
    const api = entry.api ?? 'chat'
    if (!['chat', 'responses'].includes(api) || (api === 'responses' && provider !== 'openai')) return []
    if (entry.reasoning_effort !== undefined && (provider !== 'openai' || api !== 'responses' || !reasoningEfforts.includes(entry.reasoning_effort))) return []
    if (model === 'gpt-6-astra' && entry.reasoning_effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(entry.reasoning_effort)) return []
    if (entry.thinking !== undefined && (provider !== 'anthropic' || entry.thinking !== 'adaptive' || !adaptiveModels.has(model))) return []
    if (entry.effort !== undefined && (entry.thinking !== 'adaptive' || !['low', 'medium', 'high', 'max'].includes(entry.effort))) return []
    if (provider === 'openai' && ((api === 'chat' && /(-pro|deep-research)(-|$)/.test(model)) || !openai)) return []
    let baseURL
    let key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY
    if (provider === 'compatible') {
      if (!/^PAID_AI_ROUTE_[A-Z][A-Z0-9_]*_API_KEY$/.test(entry.api_key_env || '')) return []
      try {
        const url = new URL(entry.base_url)
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return []
        baseURL = url.href.replace(/\/+$/, '')
      } catch { return [] }
      key = process.env[entry.api_key_env]
    } else if (entry.base_url || entry.api_key_env) return []
    if (provider !== 'openai' && !String(key || '').trim()) return []
    const account = createHash('sha256').update(`${provider}|${baseURL || ''}|${key || ''}`).digest('hex')
    return [{ provider, model, api, reasoningEffort: entry.reasoning_effort, thinking: entry.thinking, effort: entry.effort, baseURL, apiKeyEnv: entry.api_key_env, account,
      reasoning: entry.reasoning === true || (provider === 'openai' && /^(gpt-[5-9]|o[1-9])/.test(model)) }]
  })
  let routes = parse(entries)
  if (!routes.length && process.env.AI_PAID_ROUTES !== undefined) {
    configLog.warn('paid_routes_default_recovery', { reason: 'zero_valid_routes' })
    routes = parse(defaults)
  }
  // First native primary, other native primary, then the remaining configured rank.
  const primary = routes.find(r => r.provider !== 'compatible')
  const other = primary && routes.find(r => r.provider !== 'compatible' && r.provider !== primary.provider)
  const ordered = primary ? [primary, ...(other ? [other] : []), ...routes.filter(r => r !== primary && r !== other)] : routes
  return ordered.filter((r, i) => ordered.findIndex(x => x.account === r.account && x.model === r.model) === i)
}

export function circuitBlocked(state, route) {
  for (const [key, until] of state) if (until <= Date.now()) state.delete(key)
  return state.has(route.account) || state.has(`${route.account}:${route.model}`)
}

export function isHardPaidFailure(error) {
  const status = Number(error?.status || 0)
  const text = `${error?.code || ''} ${error?.error?.code || ''} ${error?.message || ''}`
  return [401, 402, 403].includes(status) || /insufficient[_ -]?quota|credit.*(?:low|exhaust|deplet|expir)|billing|payment required|invalid.*api.*key/i.test(text)
}

export function recordPaidFailure(state, route, error) {
  const status = Number(error?.status || 0)
  const hard = isHardPaidFailure(error)
  const retryAfter = error?.headers?.get?.('retry-after') ?? error?.headers?.['retry-after']
  const parsed = Number(retryAfter)
  const retryMs = retryAfter === null || retryAfter === undefined ? 30000 : Number.isFinite(parsed) ? parsed * 1000 : Date.parse(retryAfter) - Date.now()
  const duration = hard ? 300000 : status === 429 ? Math.min(300000, Math.max(1000, Number.isFinite(retryMs) ? retryMs : 30000)) : 5000
  circuitBlocked(state, route)
  state.set(hard ? route.account : `${route.account}:${route.model}`, Date.now() + duration)
  while (state.size > 256) state.delete(state.keys().next().value)
  return hard
}
