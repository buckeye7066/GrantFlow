import { createOpenAIClient, summarizeOpenAIError } from './openaiClient.js'
import { safeParseJSON } from './safeJson.js'
import { createLogger } from './logger.js'
import { withLLMTimeout, isLLMTimeout, LLM_TIMEOUT_MS } from './llmTimeout.js'
import {
  invokeFreeJsonRoutes,
  invokeFreeTextRoutes,
  isProviderCreditExhaustion,
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

  // Best effort: attempt to extract the first JSON object in the response.
  // Some providers may wrap JSON in prose even when instructed.
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1)
    const parsed = safeParseJSON(candidate, null)
    if (parsed) return parsed
  }

  return safeParseJSON(raw, null)
}

export function getOpenAIOptional({ timeoutMs = null, maxRetries = null } = {}) {
  try {
    return createOpenAIClient({ allowMissing: true, timeoutMs, maxRetries }).openai
  } catch {
    return null
  }
}

/**
 * Public, role-split accessor for the Anthropic client — mirrors
 * getOpenAIOptional(). Returns the cached Anthropic client, or null when
 * ANTHROPIC_API_KEY is absent/removed. Additive: it wraps the private
 * getAnthropicClient() without changing any existing export or the
 * OpenAI-first fallback behavior of invokeTextWithFallback/invokeJsonWithFallback.
 *
 * Used by the adversarial-repair loop to call Claude DIRECTLY as the code
 * AUTHOR (fable) — distinct from the fallback wrappers, where Anthropic is only
 * the OpenAI backstop, never the primary role.
 *
 * @returns {Promise<import('@anthropic-ai/sdk').default|null>}
 */
export async function getAnthropicOptional() {
  try {
    return await getAnthropicClient()
  } catch {
    return null
  }
}

// Log operational facts only: upstream messages can contain document text,
// account details, or credentials. Detailed errors remain in the existing
// return contract for callers that already handle them.
function providerFailureDiagnostics(error) {
  const summary = summarizeOpenAIError(error)
  return {
    status: summary.status,
    ...(error?.jsonFinishReason ? { finish_reason: error.jsonFinishReason } : {}),
    reason: isLLMTimeout(error)
      ? 'timed_out'
      : error?.jsonFinishReason === 'length'
        ? 'output_truncated'
        : summary.isAuth
          ? 'authentication_failed'
          : isProviderCreditExhaustion(summary)
            ? 'credit_or_quota_exhausted'
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

function combineCompletionUsage(first, second) {
  if (!first) return second ?? null
  if (!second) return first
  // Detailed cache/reasoning breakdowns describe individual requests. Return
  // the aggregate billing counters when recovery made two requests.
  const total = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isFinite(first[key]) && Number.isFinite(second[key])) total[key] = first[key] + second[key]
  }
  return total
}

// Split the existing paid window only when the second provider is configured.
// The initial OpenAI request and its one recovery share a fixed first deadline;
// a retry cannot consume the time reserved for Anthropic or free routes.
function providerBudget(timeoutMs, freeReserveMs) {
  const suppliedBudgetMs = Number(timeoutMs ?? LLM_TIMEOUT_MS)
  const requestBudgetMs = Number.isFinite(suppliedBudgetMs) ? Math.max(0, suppliedBudgetMs) : LLM_TIMEOUT_MS
  const startedAt = Date.now()
  const deadlineAt = startedAt + requestBudgetMs
  const paidDeadlineAt = deadlineAt - freeReserveMs
  const paidWindowMs = Math.max(0, paidDeadlineAt - startedAt)
  const anthropicReserveMs = String(process.env.ANTHROPIC_API_KEY || '').trim() ? paidWindowMs / 2 : 0
  const openaiDeadlineAt = paidDeadlineAt - anthropicReserveMs
  return {
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    paidAttemptMs: () => Math.max(0, paidDeadlineAt - Date.now()),
    openaiAttemptMs: () => Math.max(0, openaiDeadlineAt - Date.now()),
  }
}

function abortedResult(signal) {
  return { ok: false, provider: 'fallback', aborted: true, text: null, json: null, raw: null,
    error: signal.reason || new DOMException('Operation aborted', 'AbortError'), freeRouteErrors: [] }
}

// Omission uses the server's configured client. Explicit null remains an
// opt-out for callers that have already tried OpenAI or select Anthropic.
export async function invokeTextWithFallback({
  openai = getOpenAIOptional(),
  system = null,
  prompt,
  temperature = 0.3,
  maxTokens = 1200,
  openaiModel = null,
  anthropicModel = null,
  freeRoutes = null,
  freeClientFactory = null,
  timeoutMs = null,
  signal = null,
} = {}) {
  if (signal?.aborted) return abortedResult(signal)
  const safePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '')
  const messages = system
    ? [
        { role: 'system', content: String(system) },
        { role: 'user', content: safePrompt },
      ]
    : [{ role: 'user', content: safePrompt }]

  let openaiError = null
  let openaiAttempted = false
  let anthropicError = null
  let timedOut = false
  const configuredFreeRoutes = resolveFreeAiRoutes(freeRoutes)
  const freeReserveMs = configuredFreeRoutes.length > 0
    ? Math.max(1_000, Number(process.env.FREE_AI_RESERVE_MS || 6_000))
    : 0

  // Shared gateway-safe deadline across BOTH providers — a sequential
  // OpenAI->Anthropic fallback must never sum past the proxy's ~30s cut.
  const { remainingMs, paidAttemptMs, openaiAttemptMs } = providerBudget(timeoutMs, freeReserveMs)

  // 1) OpenAI (optional)
  if (openai && openaiAttemptMs() > 25) {
    openaiAttempted = true
    try {
      const completion = await withLLMTimeout(
        attemptSignal => openai.chat.completions.create({
          model: openaiModel || process.env.OPENAI_MODEL || process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini',
          messages,
          temperature,
          max_tokens: maxTokens,
        }, { signal: attemptSignal }),
        { timeoutMs: openaiAttemptMs(), label: 'OpenAI text generation', signal },
      )
      const text = String(completion?.choices?.[0]?.message?.content ?? '').trim()
      return { ok: true, provider: 'openai', text, raw: text, usage: completion?.usage ?? null, openaiError: null, anthropicError: null }
    } catch (error) {
      if (signal?.aborted) return abortedResult(signal)
      if (isLLMTimeout(error)) timedOut = true
      openaiError = summarizeOpenAIError(error)
      qualityLog.warn('[aiProviders] OpenAI text call failed', providerFailureDiagnostics(error))
    }
  }

  if (signal?.aborted) return abortedResult(signal)
  // 2) Anthropic (only if budget remains)
  if (paidAttemptMs() > 25 && String(process.env.ANTHROPIC_API_KEY || '').trim()) {
    try {
      const response = await withLLMTimeout(
        async attemptSignal => {
          const anthropic = await getAnthropicClient()
          attemptSignal.throwIfAborted()
          if (!anthropic) throw new Error('Anthropic is no longer configured')
          return anthropic.messages.create({
            model: anthropicModel || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
            max_tokens: maxTokens,
            temperature,
            system: system ? String(system) : undefined,
            messages: [{ role: 'user', content: safePrompt }],
          }, { signal: attemptSignal })
        },
        { timeoutMs: paidAttemptMs(), label: 'Anthropic text generation', signal },
      )
      const text = extractAnthropicText(response)
      return { ok: true, provider: 'anthropic', text, raw: text, usage: null, openaiError, anthropicError: null }
    } catch (error) {
      if (signal?.aborted) return abortedResult(signal)
      if (isLLMTimeout(error)) timedOut = true
      anthropicError = error?.message ?? String(error)
      qualityLog.error('[aiProviders] Anthropic text call failed', {
        ...providerFailureDiagnostics(error),
        openai_available: Boolean(openai),
        openai_attempted: openaiAttempted,
      })
    }
  }

  if (signal?.aborted) return abortedResult(signal)
  // 3) No-credit/local and free-tier OpenAI-compatible routes.
  const freeResult = await invokeFreeTextRoutes({
    routes: configuredFreeRoutes,
    clientFactory: freeClientFactory,
    system,
    prompt: safePrompt,
    temperature,
    maxTokens,
    timeoutMs: remainingMs(),
    signal,
  })
  if (signal?.aborted) return abortedResult(signal)
  if (freeResult.ok) {
    return {
      ...freeResult,
      fallback_reason:
        isProviderCreditExhaustion(openaiError) || isProviderCreditExhaustion(anthropicError)
          ? 'paid_provider_credit_or_quota_exhausted'
          : openaiError || anthropicError
            ? 'paid_provider_failure'
            : 'paid_provider_not_configured',
      openaiError,
      anthropicError,
    }
  }

  // 4) No providers configured / every configured provider failed or timed out
  return {
    ok: false,
    provider: 'fallback',
    text: null,
    raw: null,
    timedOut,
    error: new Error(timedOut ? 'AI service timed out — please try again.' : 'No AI provider configured or provider failure'),
    openaiError,
    anthropicError,
    freeRouteErrors: freeResult.freeRouteErrors,
  }
}

export async function invokeJsonWithFallback({
  openai = getOpenAIOptional(),
  system = null,
  prompt,
  temperature = 0.1,
  maxTokens = 1200,
  openaiModel = null,
  anthropicModel = null,
  freeRoutes = null,
  freeClientFactory = null,
  timeoutMs = null,
  signal = null,
} = {}) {
  if (signal?.aborted) return abortedResult(signal)
  const safePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '')
  let openaiError = null
  let openaiAttempted = false
  let anthropicError = null
  let timedOut = false
  const configuredFreeRoutes = resolveFreeAiRoutes(freeRoutes)
  const freeReserveMs = configuredFreeRoutes.length > 0
    ? Math.max(1_000, Number(process.env.FREE_AI_RESERVE_MS || 6_000))
    : 0

  // Shared gateway-safe deadline across BOTH providers (see invokeTextWithFallback).
  const { remainingMs, paidAttemptMs, openaiAttemptMs } = providerBudget(timeoutMs, freeReserveMs)

  // 1) OpenAI (optional)
  if (openai && openaiAttemptMs() > 25) {
    openaiAttempted = true
    try {
      const messages = [
        { role: 'system', content: [system ? String(system) : null, 'Return ONLY a complete, valid JSON object (no markdown, no prose).'].filter(Boolean).join('\n\n') },
        { role: 'user', content: safePrompt },
      ]
      let outputLimit = maxTokens
      let usage = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const completion = await withLLMTimeout(
          attemptSignal => openai.chat.completions.create({
            model: openaiModel || process.env.OPENAI_MODEL || process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini',
            temperature,
            max_tokens: outputLimit,
            response_format: { type: 'json_object' },
            messages,
          }, { signal: attemptSignal }),
          { timeoutMs: openaiAttemptMs(), label: 'OpenAI JSON generation', signal },
        )
        usage = combineCompletionUsage(usage, completion?.usage)
        const choice = completion?.choices?.[0]
        if (choice?.finish_reason === 'length') {
          const retryLimit = Math.min(8192, Math.floor(Number(maxTokens) * 2))
          if (attempt === 0 && retryLimit > Number(outputLimit) && openaiAttemptMs() > 1000) {
            qualityLog.warn('[aiProviders] OpenAI JSON response truncated; retrying once', { max_tokens: outputLimit, retry_max_tokens: retryLimit })
            outputLimit = retryLimit
            continue
          }
          throw jsonCompletionError(choice)
        }
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw jsonCompletionError(choice)
        const rawText = String(choice?.message?.content ?? '').trim()
        const parsed = isLikelyJson(rawText) ? safeParseJSON(rawText, null) : tryParseJsonLoose(rawText)
        if (!parsed || typeof parsed !== 'object') throw jsonCompletionError(choice)
        if (attempt > 0) qualityLog.info('[aiProviders] OpenAI JSON truncation recovered', { attempts: attempt + 1 })
        return { ok: true, provider: 'openai', json: parsed, raw: rawText, usage, openaiError: null, anthropicError: null }
      }
    } catch (error) {
      if (signal?.aborted) return abortedResult(signal)
      if (isLLMTimeout(error)) timedOut = true
      openaiError = summarizeOpenAIError(error)
      qualityLog.warn('[aiProviders] OpenAI JSON call failed', providerFailureDiagnostics(error))
    }
  }

  if (signal?.aborted) return abortedResult(signal)
  // 2) Anthropic (only if budget remains)
  if (paidAttemptMs() > 25 && String(process.env.ANTHROPIC_API_KEY || '').trim()) {
    try {
      const systemText = [
        system ? String(system) : null,
        'Return ONLY valid JSON (no markdown, no prose).',
      ]
        .filter(Boolean)
        .join('\n\n')

      const response = await withLLMTimeout(
        async attemptSignal => {
          const anthropic = await getAnthropicClient()
          attemptSignal.throwIfAborted()
          if (!anthropic) throw new Error('Anthropic is no longer configured')
          return anthropic.messages.create({
            model: anthropicModel || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
            max_tokens: maxTokens,
            temperature,
            system: systemText || undefined,
            messages: [{ role: 'user', content: safePrompt }],
          }, { signal: attemptSignal })
        },
        { timeoutMs: paidAttemptMs(), label: 'Anthropic JSON generation', signal },
      )
      const rawText = extractAnthropicText(response)
      const parsed = isLikelyJson(rawText) ? safeParseJSON(rawText, null) : tryParseJsonLoose(rawText)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Anthropic returned invalid JSON')
      }
      return { ok: true, provider: 'anthropic', json: parsed, raw: rawText, usage: null, openaiError, anthropicError: null }
    } catch (error) {
      if (signal?.aborted) return abortedResult(signal)
      if (isLLMTimeout(error)) timedOut = true
      anthropicError = error?.message ?? String(error)
      qualityLog.error('[aiProviders] Anthropic JSON call failed', {
        ...providerFailureDiagnostics(error),
        openai_available: Boolean(openai),
        openai_attempted: openaiAttempted,
      })
    }
  }

  if (signal?.aborted) return abortedResult(signal)
  // 3) No-credit/local and free-tier OpenAI-compatible routes.
  const freeResult = await invokeFreeJsonRoutes({
    routes: configuredFreeRoutes,
    clientFactory: freeClientFactory,
    system,
    prompt: safePrompt,
    temperature,
    maxTokens,
    timeoutMs: remainingMs(),
    signal,
  })
  if (signal?.aborted) return abortedResult(signal)
  if (freeResult.ok) {
    return {
      ...freeResult,
      fallback_reason:
        isProviderCreditExhaustion(openaiError) || isProviderCreditExhaustion(anthropicError)
          ? 'paid_provider_credit_or_quota_exhausted'
          : openaiError || anthropicError
            ? 'paid_provider_failure'
            : 'paid_provider_not_configured',
      openaiError,
      anthropicError,
    }
  }

  return {
    ok: false,
    provider: 'fallback',
    json: null,
    raw: null,
    timedOut,
    error: new Error(timedOut ? 'AI service timed out — please try again.' : 'No AI provider configured or provider failure'),
    openaiError,
    anthropicError,
    freeRouteErrors: freeResult.freeRouteErrors,
  }
}
