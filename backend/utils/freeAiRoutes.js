import OpenAI from 'openai'

import { withLLMTimeout } from './llmTimeout.js'
import { safeParseJSON } from './safeJson.js'
import { createLogger } from './logger.js'

const log = createLogger('utils:freeAiRoutes')
const MAX_ROUTES = 6
const FREE_ROUTE_ENV_KEYS = Object.freeze({
  genericApiKey: 'FREE_AI_API_KEY',
  ollamaApiKey: 'OLLAMA_API_KEY',
})

function parseJsonLoose(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const direct = safeParseJSON(raw, null)
  if (direct && typeof direct === 'object') return direct
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  return first >= 0 && last > first ? safeParseJSON(raw.slice(first, last + 1), null) : null
}

function normalizeRoute(entry, index) {
  if (!entry || typeof entry !== 'object') return null
  const baseURL = String(entry.base_url ?? entry.baseURL ?? '').trim().replace(/\/+$/, '')
  const model = String(entry.model ?? '').trim()
  if (!baseURL || !model) return null
  let url
  try { url = new URL(baseURL) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  const rawId = String(entry.id || `route-${index + 1}`).trim().toLowerCase()
  const id = rawId.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `route-${index + 1}`
  const apiKeyEnv = String(entry.api_key_env ?? entry.apiKeyEnv ?? '').trim()
  return {
    id,
    baseURL,
    model,
    apiKeyEnv: /^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv) ? apiKeyEnv : null,
  }
}

/**
 * Resolve ordered free-tier or self-hosted OpenAI-compatible routes.
 * Route JSON references secrets by env-var name; secret values are never
 * returned by this function or included in diagnostics.
 */
export function getConfiguredFreeAiRoutes(env = process.env) {
  const candidates = []
  const raw = String(env?.FREE_AI_ROUTES || '').trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) candidates.push(...parsed)
      else log.warn('FREE_AI_ROUTES must be a JSON array; ignoring it')
    } catch {
      log.warn('FREE_AI_ROUTES is invalid JSON; ignoring it')
    }
  }
  if (String(env?.FREE_AI_BASE_URL || '').trim() && String(env?.FREE_AI_MODEL || '').trim()) {
    candidates.push({
      id: 'free-compatible',
      base_url: env.FREE_AI_BASE_URL,
      model: env.FREE_AI_MODEL,
      api_key_env: FREE_ROUTE_ENV_KEYS.genericApiKey,
    })
  }
  if (String(env?.OLLAMA_BASE_URL || '').trim()) {
    candidates.push({
      id: 'ollama',
      base_url: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL || env.FREE_AI_MODEL || 'llama3.2',
      api_key_env: FREE_ROUTE_ENV_KEYS.ollamaApiKey,
    })
  }

  const seen = new Set()
  return candidates
    .map(normalizeRoute)
    .filter(Boolean)
    .filter((route) => {
      const key = `${route.baseURL.toLowerCase()}|${route.model.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_ROUTES)
}

export function resolveFreeAiRoutes(routes, env = process.env) {
  if (routes === null || routes === undefined) return getConfiguredFreeAiRoutes(env)
  return Array.isArray(routes) ? routes.map(normalizeRoute).filter(Boolean).slice(0, MAX_ROUTES) : []
}

export function isProviderCreditExhaustion(error) {
  const status = Number(error?.status ?? error?.response?.status ?? 0)
  const message = String(
    error?.message ?? error?.error?.message ?? error?.response?.data?.error?.message ?? error ?? '',
  )
  return status === 402 || status === 429 ||
    /insufficient[_ -]?quota|credit(?:s)? (?:balance )?(?:exhausted|depleted|expired)|billing|payment required|spend limit|quota exceeded|rate limit/i.test(message)
}

function clientFor(route, env = process.env) {
  const apiKey = route.apiKeyEnv ? String(env?.[route.apiKeyEnv] || '').trim() : ''
  return {
    client: new OpenAI({
      apiKey: apiKey || 'grantflow-local-no-key',
      baseURL: route.baseURL,
      timeout: Number(env?.FREE_AI_TIMEOUT_MS || 12_000),
      maxRetries: Number(env?.FREE_AI_MAX_RETRIES || 0),
    }),
    apiKey,
  }
}

function safeError(error, route, apiKey) {
  let message = String(error?.message ?? error ?? 'free route failed')
  if (apiKey) message = message.split(String(apiKey)).join('***REDACTED***')
  message = message.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ***REDACTED***')
  return {
    route_id: route.id,
    status: Number(error?.status ?? error?.response?.status ?? 0) || null,
    message: message.slice(0, 500),
    credit_exhausted: isProviderCreditExhaustion(error),
  }
}

async function invokeRoutes({
  routes,
  clientFactory,
  system,
  prompt,
  temperature,
  maxTokens,
  jsonOnly,
  timeoutMs,
}) {
  const errors = []
  const deadlineAt = Date.now() + Math.max(500, Number(timeoutMs) || 10_000)
  for (let index = 0; index < routes.length; index += 1) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 500) break
    const route = routes[index]
    let apiKey = ''
    try {
      const built = await (clientFactory ? clientFactory(route) : clientFor(route))
      const client = built?.client ?? built
      apiKey = built?.apiKey ?? ''
      if (!client?.chat?.completions?.create) throw new Error('route is not OpenAI-compatible')
      const systemText = [
        system ? String(system) : null,
        jsonOnly ? 'Return ONLY valid JSON (no markdown, no prose).' : null,
      ].filter(Boolean).join('\n\n')
      const messages = [
        ...(systemText ? [{ role: 'system', content: systemText }] : []),
        { role: 'user', content: String(prompt ?? '') },
      ]
      const routesLeft = Math.max(1, routes.length - index)
      const completion = await withLLMTimeout(
        client.chat.completions.create({
          model: route.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        {
          timeoutMs: Math.max(500, Math.floor(remainingMs / routesLeft)),
          label: `Free AI route ${route.id}`,
        },
      )
      const raw = String(completion?.choices?.[0]?.message?.content ?? '').trim()
      if (!raw) throw new Error('route returned an empty response')
      const common = {
        ok: true,
        provider: `free:${route.id}`,
        route_id: route.id,
        model: route.model,
        raw,
        usage: completion?.usage ?? null,
        degraded: true,
        freeRouteErrors: errors,
      }
      if (!jsonOnly) return { ...common, text: raw }
      const json = parseJsonLoose(raw)
      if (!json || typeof json !== 'object') throw new Error('route returned invalid JSON')
      return { ...common, json }
    } catch (error) {
      errors.push(safeError(error, route, apiKey))
      log.warn(`Free AI route ${route.id} failed; trying the next configured route`)
    }
  }
  return { ok: false, freeRouteErrors: errors }
}

export function invokeFreeTextRoutes(options) {
  return invokeRoutes({ ...options, jsonOnly: false })
}

export function invokeFreeJsonRoutes(options) {
  return invokeRoutes({ ...options, jsonOnly: true })
}
