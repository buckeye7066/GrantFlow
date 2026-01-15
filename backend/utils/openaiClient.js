import OpenAI from 'openai'

function stripWrappingQuotes(value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).trim()
  }
  return v
}

function normalizeOpenAIKey(rawValue) {
  // Accept common copy/paste mistakes:
  // - "OPENAI_API_KEY=sk-..."
  // - "OPENAI_API_KEY= sk-... railway: ..."
  // - quoted values
  const raw = stripWrappingQuotes(rawValue)

  // If the string includes an env assignment, take the part after the first "="
  const afterEquals = raw.includes('=') ? raw.split('=').slice(1).join('=').trim() : raw.trim()

  // Extract the first plausible OpenAI key token (keys never contain whitespace).
  // Supports sk-... and sk-proj-...
  const match = afterEquals.match(/sk-[A-Za-z0-9_-]+/)
  return (match?.[0] || afterEquals).trim()
}

export function getNormalizedOpenAIKey() {
  const raw = process.env.OPENAI_API_KEY ?? ''
  return normalizeOpenAIKey(raw)
}

function getOpenAIKeyDiagnosticsFromKey(rawKey) {
  const key = normalizeOpenAIKey(rawKey)
  return {
    present: Boolean(key),
    length: key ? key.length : 0,
    // only expose a short prefix for debugging; never return the full key
    prefix: key ? `${key.slice(0, 7)}...` : null,
    looks_masked: key ? key.includes('*') : false,
    looks_like_openai_key: key ? key.startsWith('sk-') : false,
  }
}

export function getOpenAIKeyDiagnostics() {
  return getOpenAIKeyDiagnosticsFromKey(process.env.OPENAI_API_KEY ?? '')
}

export function createOpenAIClient({ allowMissing = false, apiKeyOverride = null } = {}) {
  const apiKeyRaw = apiKeyOverride ?? (process.env.OPENAI_API_KEY ?? '')
  const apiKey = normalizeOpenAIKey(apiKeyRaw)
  const diagnostics = getOpenAIKeyDiagnosticsFromKey(apiKeyRaw)

  if (!apiKey || apiKey === 'YOUR_OPENAI_API_KEY' || apiKey.includes('*')) {
    if (allowMissing) {
      return { openai: null, diagnostics }
    }
    throw new Error(
      `OpenAI is not configured. Set OPENAI_API_KEY (server-side) and restart the backend. diagnostics=${JSON.stringify(
        diagnostics,
      )}`,
    )
  }

  const timeout = Number(process.env.OPENAI_TIMEOUT_MS || 20000)
  const maxRetries = Number(process.env.OPENAI_MAX_RETRIES || 2)

  return {
    openai: new OpenAI({
      apiKey,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 20000,
      maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 2,
    }),
    diagnostics,
  }
}

export function summarizeOpenAIError(error) {
  const status = error?.status ?? error?.response?.status ?? null
  const message = error instanceof Error ? error.message : String(error)

  // OpenAI SDK often provides { status, error: { message } } shapes too
  const nestedMessage =
    error?.error?.message || error?.response?.data?.error?.message || error?.response?.data?.message

  const finalMessage = String(nestedMessage || message || 'Unknown OpenAI error')

  const isAuth =
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|api key not valid|unauthorized/i.test(finalMessage)

  const isRateLimit = status === 429 || /rate limit|too many requests/i.test(finalMessage)

  return {
    status,
    message: finalMessage,
    isAuth,
    isRateLimit,
  }
}

