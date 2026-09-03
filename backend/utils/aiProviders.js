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

export async function invokeTextWithFallback({
  openai = null,
  system = null,
  prompt,
  temperature = 0.3,
  maxTokens = 1200,
  openaiModel = null,
  anthropicModel = null,
  freeRoutes = null,
  freeClientFactory = null,
  timeoutMs = null,
} = {}) {
  const safePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '')
  const messages = system
    ? [
        { role: 'system', content: String(system) },
        { role: 'user', content: safePrompt },
      ]
    : [{ role: 'user', content: safePrompt }]

  let openaiError = null
  let anthropicError = null
  let timedOut = false
  const configuredFreeRoutes = resolveFreeAiRoutes(freeRoutes)
  const freeReserveMs = configuredFreeRoutes.length > 0
    ? Math.max(1_000, Number(process.env.FREE_AI_RESERVE_MS || 6_000))
    : 0

  // Shared gateway-safe deadline across BOTH providers — a sequential
  // OpenAI->Anthropic fallback must never sum past the proxy's ~30s cut.
  const requestBudgetMs = Math.max(1, Number(timeoutMs ?? LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS)
  const deadlineAt = Date.now() + requestBudgetMs
  const remainingMs = () => deadlineAt - Date.now()
  const paidAttemptMs = () => Math.max(0, remainingMs() - freeReserveMs)

  // 1) OpenAI (optional)
  if (openai && paidAttemptMs() > 25) {
    try {
      const completion = await withLLMTimeout(
        openai.chat.completions.create({
          model: openaiModel || process.env.OPENAI_MODEL || process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini',
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        { timeoutMs: paidAttemptMs(), label: 'OpenAI text generation' },
      )
      const text = String(completion?.choices?.[0]?.message?.content ?? '').trim()
      return { ok: true, provider: 'openai', text, raw: text, usage: completion?.usage ?? null, openaiError: null, anthropicError: null }
    } catch (error) {
      if (isLLMTimeout(error)) timedOut = true
      openaiError = summarizeOpenAIError(error)
    }
  }

  // 2) Anthropic (only if budget remains)
  const anthropic = paidAttemptMs() > 25 ? await getAnthropicClient() : null
  if (anthropic) {
    try {
      const response = await withLLMTimeout(
        anthropic.messages.create({
          model: anthropicModel || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
          max_tokens: maxTokens,
          temperature,
          system: system ? String(system) : undefined,
          messages: [{ role: 'user', content: safePrompt }],
        }),
        { timeoutMs: paidAttemptMs(), label: 'Anthropic text generation' },
      )
      const text = extractAnthropicText(response)
      return { ok: true, provider: 'anthropic', text, raw: text, usage: null, openaiError, anthropicError: null }
    } catch (error) {
      if (isLLMTimeout(error)) timedOut = true
      anthropicError = error?.message ?? String(error)
      qualityLog.error('[aiProviders] Anthropic text call failed:', anthropicError)
    }
  }

  // 3) No-credit/local and free-tier OpenAI-compatible routes.
  const freeResult = await invokeFreeTextRoutes({
    routes: configuredFreeRoutes,
    clientFactory: freeClientFactory,
    system,
    prompt: safePrompt,
    temperature,
    maxTokens,
    timeoutMs: remainingMs(),
  })
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
  openai = null,
  system = null,
  prompt,
  temperature = 0.1,
  maxTokens = 1200,
  openaiModel = null,
  anthropicModel = null,
  freeRoutes = null,
  freeClientFactory = null,
  timeoutMs = null,
} = {}) {
  const safePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '')
  let openaiError = null
  let anthropicError = null
  let timedOut = false
  const configuredFreeRoutes = resolveFreeAiRoutes(freeRoutes)
  const freeReserveMs = configuredFreeRoutes.length > 0
    ? Math.max(1_000, Number(process.env.FREE_AI_RESERVE_MS || 6_000))
    : 0

  // Shared gateway-safe deadline across BOTH providers (see invokeTextWithFallback).
  const requestBudgetMs = Math.max(1, Number(timeoutMs ?? LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS)
  const deadlineAt = Date.now() + requestBudgetMs
  const remainingMs = () => deadlineAt - Date.now()
  const paidAttemptMs = () => Math.max(0, remainingMs() - freeReserveMs)

  // 1) OpenAI (optional)
  if (openai && paidAttemptMs() > 25) {
    try {
      const completion = await withLLMTimeout(
        openai.chat.completions.create({
          model: openaiModel || process.env.OPENAI_MODEL || process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini',
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            ...(system ? [{ role: 'system', content: String(system) }] : []),
            { role: 'user', content: safePrompt },
          ],
        }),
        { timeoutMs: paidAttemptMs(), label: 'OpenAI JSON generation' },
      )
      const rawText = String(completion?.choices?.[0]?.message?.content ?? '').trim()
      const parsed = isLikelyJson(rawText) ? safeParseJSON(rawText, null) : tryParseJsonLoose(rawText)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('OpenAI returned invalid JSON')
      }
      return { ok: true, provider: 'openai', json: parsed, raw: rawText, usage: completion?.usage ?? null, openaiError: null, anthropicError: null }
    } catch (error) {
      if (isLLMTimeout(error)) timedOut = true
      openaiError = summarizeOpenAIError(error)
    }
  }

  // 2) Anthropic (only if budget remains)
  const anthropic = paidAttemptMs() > 25 ? await getAnthropicClient() : null
  if (anthropic) {
    try {
      const systemText = [
        system ? String(system) : null,
        'Return ONLY valid JSON (no markdown, no prose).',
      ]
        .filter(Boolean)
        .join('\n\n')

      const response = await withLLMTimeout(
        anthropic.messages.create({
          model: anthropicModel || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
          max_tokens: maxTokens,
          temperature,
          system: systemText || undefined,
          messages: [{ role: 'user', content: safePrompt }],
        }),
        { timeoutMs: paidAttemptMs(), label: 'Anthropic JSON generation' },
      )
      const rawText = extractAnthropicText(response)
      const parsed = isLikelyJson(rawText) ? safeParseJSON(rawText, null) : tryParseJsonLoose(rawText)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Anthropic returned invalid JSON')
      }
      return { ok: true, provider: 'anthropic', json: parsed, raw: rawText, usage: null, openaiError, anthropicError: null }
    } catch (error) {
      if (isLLMTimeout(error)) timedOut = true
      anthropicError = error?.message ?? String(error)
      qualityLog.error('[aiProviders] Anthropic JSON call failed:', anthropicError)
    }
  }

  // 3) No-credit/local and free-tier OpenAI-compatible routes.
  const freeResult = await invokeFreeJsonRoutes({
    routes: configuredFreeRoutes,
    clientFactory: freeClientFactory,
    system,
    prompt: safePrompt,
    temperature,
    maxTokens,
    timeoutMs: remainingMs(),
  })
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

