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

// Keep every supported key explicit so the generated environment inventory and
// example-file authority can discover the configuration surface. Resolve this
// on each call so an admin runtime override is visible without a restart.
function currentFreeAiEnv() {
  return {
    FREE_AI_ROUTES: process.env.FREE_AI_ROUTES,
    FREE_AI_BASE_URL: process.env.FREE_AI_BASE_URL,
    FREE_AI_MODEL: process.env.FREE_AI_MODEL,
    FREE_AI_API_KEY: process.env.FREE_AI_API_KEY,
    FREE_AI_TIMEOUT_MS: process.env.FREE_AI_TIMEOUT_MS,
    FREE_AI_MAX_RETRIES: process.env.FREE_AI_MAX_RETRIES,
    FREE_AI_RESERVE_MS: process.env.FREE_AI_RESERVE_MS,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
  }
}

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
export function getConfiguredFreeAiRoutes(env = currentFreeAiEnv()) {
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

export function resolveFreeAiRoutes(routes, env = currentFreeAiEnv()) {
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

function clientFor(route, env = currentFreeAiEnv()) {
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

function safeError(error) {
  const status = Number(error?.status ?? error?.response?.status ?? 0) || null
  const creditExhausted = isProviderCreditExhaustion(error)
  const raw = String(error?.message ?? error ?? '')
  const timedOut = error?.name === 'AbortError' || error?.code === 'ERR_CANCELED' || /timeout|timed out|aborted/i.test(raw)
  const responseRejected = /empty response|invalid json|not OpenAI-compatible/i.test(raw)
  const message = creditExhausted
    ? 'free route quota or rate limit reached'
    : timedOut
      ? 'free route timed out'
      : responseRejected
        ? 'free route response rejected'
        : status && status >= 400 && status < 500
          ? 'free route rejected the request'
          : 'free route unavailable'
  return {
    status,
    message,
    credit_exhausted: creditExhausted,
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
      errors.push(safeError(error))
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
