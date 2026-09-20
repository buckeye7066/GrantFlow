import { tryOwnerSubscription } from '../services/ownerAi/ownerAiBroker.js'
import { getOwnerAiScope } from '../services/ownerAi/ownerAiScope.js'
import OpenAI from 'openai'
import { wrapOwnerSdkClient, unwrapOwnerSdkClient } from './ownerSdkRouting.js'
import { isTransientProviderError } from './providerFailure.js'
import { resolvePaidAiRoutes, paidCircuitState, circuitFailure, circuitBlocked, recordPaidFailure, isHardPaidFailure } from './paidAiRoutes.js'
import { createOpenAIClient, summarizeOpenAIError } from './openaiClient.js'
import { safeParseJSON } from './safeJson.js'
import { createLogger } from './logger.js'
import { withLLMTimeout, isLLMTimeout, LLM_TIMEOUT_MS } from './llmTimeout.js'
import {
  invokeFreeJsonRoutes,
  invokeFreeTextRoutes,
  resolveFreeAiRoutes,
} from './freeAiRoutes.js'
const qualityLog = createLogger('utils:aiProviders')

let cachedAnthropic = null
let cachedAnthropicKey = null

async function getAnthropicClient() {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) {
    if (cachedAnthropic) {
      console.warn('[aiProviders] ANTHROPIC_API_KEY removed after init – clearing cached client')
      cachedAnthropic = null
      cachedAnthropicKey = null
    }
    return null
  }
  if (cachedAnthropic && cachedAnthropicKey === key) return cachedAnthropic
  if (cachedAnthropic && cachedAnthropicKey !== key) {
    console.warn('[aiProviders] ANTHROPIC_API_KEY changed – rebuilding Anthropic client')
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic({
    apiKey: key,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || process.env.ANTHROPIC_TIMEOUT_MS || 15_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || process.env.ANTHROPIC_MAX_RETRIES || 1),
  })
  cachedAnthropic = client
  cachedAnthropicKey = key
  return cachedAnthropic
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isLikelyJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  return raw.startsWith('{') || raw.startsWith('[')
}

function tryParseJsonLoose(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  // Accept a complete markdown fence, never salvage a prefix from malformed JSON.
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return safeParseJSON(fenced ? fenced[1] : raw, null)
}

export function getOpenAIOptional({ timeoutMs = null, maxRetries = null } = {}) {
  try {
    return createOpenAIClient({ allowMissing: true, ownerInference: true, timeoutMs, maxRetries }).openai
  } catch {
    return null
  }
}

/**
 * Public, role-split accessor for the Anthropic client — mirrors
 * getOpenAIOptional(). Returns the cached Anthropic client, or null when
 * ANTHROPIC_API_KEY is absent/removed. Additive: it wraps the private
 * getAnthropicClient() without changing any existing export.
 *
 * Used by the adversarial-repair loop to call Claude DIRECTLY as the code
 * AUTHOR (fable), independently of the gateway's configured route order.
 *
 * @returns {Promise<import('@anthropic-ai/sdk').default|null>}
 */
export async function getAnthropicOptional() {
  try {
    return wrapOwnerSdkClient(await getAnthropicClient(), 'anthropic', { providerSpecific: true })
  } catch {
    return null
  }
}

// Log operational facts only: upstream messages can contain document text,
// account details, or credentials. Returned error fields retain their types
// but carry safe reason labels instead of upstream messages.
function providerFailureDiagnostics(error) {
  const summary = summarizeOpenAIError(error)
  return {
    status: summary.status,
    transient: isTransientProviderError(error) || summary.isRateLimit || (isHardPaidFailure(error) && !summary.isAuth),
    ...(error?.jsonFinishReason ? { finish_reason: error.jsonFinishReason } : {}),
    reason: isLLMTimeout(error)
      ? 'timed_out'
      : error?.jsonFinishReason === 'length'
        ? 'output_truncated'
        : summary.isAuth
          ? 'authentication_failed'
          : isHardPaidFailure(error)
            ? 'credit_or_quota_exhausted'
            : summary.isRateLimit
              ? 'rate_limited'
            : /invalid JSON/i.test(summary.message)
              ? 'invalid_response'
              : 'provider_request_failed',
  }
}

function jsonCompletionError(choice) {
  const error = new Error('OpenAI returned invalid JSON')
  // Use SDK-defined labels only; never put model output in diagnostics.
  error.jsonFinishReason = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice?.finish_reason)
    ? choice.finish_reason : 'unknown'
  return error
}

// Responses output is typed: never accept convenience text, refusals, or tool results.
function extractResponsesText(response) {
  if (response?.status !== 'completed' || !Array.isArray(response.output)) throw jsonCompletionError()
  const texts = []
  for (const item of response.output) {
    if (item?.type === 'reasoning') continue
    if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) throw jsonCompletionError()
    for (const part of item.content) {
      if (part?.type !== 'output_text' || typeof part.text !== 'string') throw jsonCompletionError()
      texts.push(part.text)
    }
  }
  return texts.join('\n').trim()
}

function combineCompletionUsage(first, second) {
  if (!first) return second ?? null
  if (!second) return first
  // Detailed cache/reasoning breakdowns describe individual requests. Return
  // the aggregate billing counters when recovery made two requests.
  const total = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isFinite(first[key]) && Number.isFinite(second[key])) total[key] = first[key] + second[key]
  }
  return total
}

function abortedResult(signal) {
  return { ok: false, provider: 'fallback', aborted: true, text: null, json: null, raw: null,
    error: signal.reason || new DOMException('Operation aborted', 'AbortError'), freeRouteErrors: [] }
}

export function invokeTextWithFallback(options = {}) { return invokePaidLadder(options, false) }
export function invokeJsonWithFallback(options = {}) { return invokePaidLadder(options, true) }

async function invokePaidLadder({
  openai = getOpenAIOptional({ maxRetries: 0 }), system = null, prompt,
  temperature, maxTokens = 1200, openaiModel = null, anthropicModel = null,
  freeRoutes = null, freeClientFactory = null, responseSchema = null, structuredInput = null, timeoutMs = null, signal: callerSignal = null,
  paidCircuitState: injectedState, excludedProviders = [],
} = {}, jsonOnly) {
  const ownerScope = getOwnerAiScope({ includeAborted: true })
  const signal = ownerScope
    ? AbortSignal.any([ownerScope.signal, ...(callerSignal ? [callerSignal] : [])])
    : callerSignal
  if (signal?.aborted) return abortedResult(signal)
  const supplied = Number(timeoutMs ?? LLM_TIMEOUT_MS)
  const budget = Number.isFinite(supplied) ? Math.max(0, supplied) : LLM_TIMEOUT_MS
  const deadline = Date.now() + budget
  const remaining = () => Math.max(0, deadline - Date.now())
  const safePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '')
  // Owner subscription work uses the same caller deadline, with time left for APIs.
  // The canonical request scope excludes customers, other admins and service tokens.
  const configuredSubscriptionWindow = Number(process.env.OWNER_AI_SUBSCRIPTION_TIMEOUT_MS ?? 20000)
  const subscriptionWindow = Math.min(budget / 2,
    Number.isFinite(configuredSubscriptionWindow) ? Math.max(0, Math.min(60000, configuredSubscriptionWindow)) : 20000)
  if (ownerScope && subscriptionWindow > 0) {
    try {
      const subscription = await withLLMTimeout(attemptSignal => tryOwnerSubscription({
        format: jsonOnly ? 'json' : 'text', system, prompt: safePrompt, maxTokens,
        timeoutMs: subscriptionWindow, signal: attemptSignal,
      }), { timeoutMs: subscriptionWindow, signal, label: 'Owner subscription request' })
      if (signal?.aborted) return abortedResult(signal)
      if (subscription?.ok === true) return subscription
    } catch {
      if (signal?.aborted) return abortedResult(signal)
      qualityLog.warn('owner_subscription_unavailable', { reason: 'bounded_subscription_attempt_failed' })
    }
  }
  // The owner's monthly allowance must not silently become metered usage.
  // This policy affects only a canonically authenticated owner request.
  const ownerMeteredDisabled = Boolean(ownerScope && process.env.OWNER_AI_ALLOW_PAID_FALLBACK !== 'true')
  const excluded = new Set(Array.isArray(excludedProviders) ? excludedProviders : [])
  const routes = ownerMeteredDisabled ? [] : resolvePaidAiRoutes({ openai, openaiModel, anthropicModel }).filter(route => !excluded.has(route.provider))
  // Legacy calls retain request-local state; configured ladders share bounded cooldowns.
  const state = injectedState ?? (process.env.AI_PAID_ROUTES ? paidCircuitState() : new Map())
  const configuredFreeRoutes = resolveFreeAiRoutes(freeRoutes)
  const configuredReserve = Number(process.env.FREE_AI_RESERVE_MS || 6000)
  const reserve = configuredFreeRoutes.length ? Math.min(budget / 2, Math.max(1000, Number.isFinite(configuredReserve) ? configuredReserve : 6000)) : 0
  const paidDeadline = deadline - reserve
  let openaiError = null
  let anthropicError = null
  let timedOut = false
  let failed = false
  let transient = false
  let exhausted = false
  for (let index = 0; index < routes.length; index += 1) {
    if (signal?.aborted) return abortedResult(signal)
    const route = routes[index]
    const blocked = circuitFailure(state, route)
    if (blocked) {
      transient ||= blocked.transient === true
      failed = true
      timedOut ||= blocked.reason === 'timed_out'
      exhausted ||= blocked.reason === 'credit_or_quota_exhausted'
      if (route.provider === 'openai') openaiError = blocked
      if (route.provider === 'anthropic') anthropicError = blocked
      continue
    }
    const window = paidDeadline - Date.now()
    if (window <= 25) break
    const later = routes.slice(index + 1).filter(r => !circuitBlocked(state, r)).length
    // Reserve half for later models rather than dividing a primary into tiny slices.
    const attemptDeadline = Date.now() + window / (later ? 2 : 1)
    const attemptRemaining = () => Math.max(0, attemptDeadline - Date.now())
    try {
      let usage = null
      let outputLimit = maxTokens
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await withLLMTimeout(async attemptSignal => {
          const requestOptions = { signal: attemptSignal, maxRetries: 0 }
          if (route.provider === 'anthropic') {
            const client = await getAnthropicClient()
            attemptSignal.throwIfAborted()
            if (!client) throw new Error('Provider unavailable')
            return client.messages.create({ model: route.model, max_tokens: outputLimit,
              ...(route.thinking === 'adaptive'
                ? { thinking: { type: 'adaptive' }, ...(route.effort ? { output_config: { effort: route.effort } } : {}) }
                : { temperature: temperature ?? (jsonOnly ? 0.1 : 0.3) }),
              system: [system, jsonOnly ? 'Return ONLY valid JSON (no markdown, no prose).' : null].filter(Boolean).join('\n\n') || undefined,
              messages: [{ role: 'user', content: safePrompt }],
            }, requestOptions)
          }
          const client = route.provider === 'openai' ? unwrapOwnerSdkClient(openai) : new OpenAI({
            apiKey: process.env[route.apiKeyEnv], baseURL: route.baseURL, maxRetries: 0,
          })
          attemptSignal.throwIfAborted()
          const systemText = [system, jsonOnly ? 'Return ONLY a complete, valid JSON object (no markdown, no prose).' : null].filter(Boolean).join('\n\n')
          if (route.api === 'responses') return client.responses.create({
            model: route.model, max_output_tokens: outputLimit, store: false,
            ...(systemText ? { instructions: systemText } : {}),
            // Responses JSON mode validates input messages, not instructions.
            input: jsonOnly ? safePrompt + '\n\nReturn ONLY a complete, valid JSON object.' : safePrompt,
            ...(jsonOnly ? { text: { format: { type: 'json_object' } } } : {}),
            ...(route.reasoningEffort ? { reasoning: { effort: route.reasoningEffort } } : {}),
          }, requestOptions)
          return client.chat.completions.create({
            model: route.model,
            ...(route.reasoning ? { max_completion_tokens: outputLimit } : { max_tokens: outputLimit, temperature: temperature ?? (jsonOnly ? 0.1 : 0.3) }),
            ...(jsonOnly ? { response_format: { type: 'json_object' } } : {}),
            messages: [...(systemText ? [{ role: 'system', content: systemText }] : []), { role: 'user', content: safePrompt }],
          }, requestOptions)
        }, { timeoutMs: attemptRemaining(), signal, label: 'Paid AI request' })
        const anthropic = route.provider === 'anthropic'
        usage = anthropic ? null : combineCompletionUsage(usage, response?.usage)
        const responses = route.api === 'responses'
        const choice = responses
          ? { finish_reason: response?.status === 'incomplete' && response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : response?.status === 'completed' ? 'stop' : 'unknown' }
          : response?.choices?.[0]
        if (!anthropic && jsonOnly && choice?.finish_reason === 'length') {
          const retryLimit = Math.min(8192, Math.floor(Number(maxTokens) * 2))
          if (attempt === 0 && retryLimit > Number(outputLimit) && attemptRemaining() > 1000) {
            outputLimit = retryLimit
            continue
          }
          throw jsonCompletionError(choice)
        }
        if ((!anthropic && choice?.finish_reason && choice.finish_reason !== 'stop') ||
            (anthropic && response?.stop_reason && response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence')) {
          throw jsonCompletionError(choice)
        }
        const raw = anthropic ? extractAnthropicText(response) : responses ? extractResponsesText(response) : String(choice?.message?.content ?? '').trim()
        if (!raw) throw jsonCompletionError(choice)
        const json = jsonOnly ? (isLikelyJson(raw) ? safeParseJSON(raw, null) : tryParseJsonLoose(raw)) : null
        if (jsonOnly && (!json || typeof json !== 'object')) throw jsonCompletionError(choice)
        return { ok: true, provider: route.provider, model: responses && typeof response?.model === 'string' && response.model.trim() ? response.model : route.model, billing_mode: 'paid_api',
          ...(jsonOnly ? { json } : { text: raw }), raw, usage, openaiError, anthropicError }
      }
    } catch (error) {
      if (signal?.aborted) return abortedResult(signal)
      failed = true
      timedOut ||= isLLMTimeout(error)
      const diagnostics = providerFailureDiagnostics(error)
      transient ||= diagnostics.transient === true
      const cause = { ...diagnostics, message: diagnostics.reason }
      exhausted = recordPaidFailure(state, route, error, cause) || exhausted
      // Preserve classified status/retryability, never upstream messages.
      if (route.provider === 'openai') openaiError = cause
      if (route.provider === 'anthropic') anthropicError = cause
      const label = route.provider === 'openai' ? 'OpenAI' : route.provider === 'anthropic' ? 'Anthropic' : 'Compatible paid'
      qualityLog.warn(`${label} ${jsonOnly ? 'JSON' : 'text'} call failed`, {
        ...diagnostics, openai_available: Boolean(openai), openai_attempted: Boolean(openaiError),
      })
    }
  }
  if (signal?.aborted) return abortedResult(signal)
  const freeResult = await (jsonOnly ? invokeFreeJsonRoutes : invokeFreeTextRoutes)({
    routes: configuredFreeRoutes, clientFactory: freeClientFactory, system, prompt: safePrompt, responseSchema, structuredInput,
    temperature: temperature ?? (jsonOnly ? 0.1 : 0.3), maxTokens, timeoutMs: remaining(), signal,
  })
  if (signal?.aborted) return abortedResult(signal)
  if (freeResult.ok) return { ...freeResult, billing_mode: 'free_or_local', openaiError, anthropicError,
    fallback_reason: ownerMeteredDisabled ? 'owner_metered_fallback_disabled' : exhausted ? 'paid_provider_credit_or_quota_exhausted' : failed || routes.length ? 'paid_provider_failure' : 'paid_provider_not_configured' }
  return { ok: false, provider: 'fallback', ...(jsonOnly ? { json: null } : { text: null }), raw: null, timedOut, transient,
    error: new Error(timedOut ? 'AI service timed out — please try again.' : 'No AI provider configured or provider failure'),
    openaiError, anthropicError, freeRouteErrors: freeResult.freeRouteErrors }
}
