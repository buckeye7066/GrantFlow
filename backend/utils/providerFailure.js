import { isLLMTimeout } from './llmTimeout.js'

// One transport classification for SDK adapters and the provider gateway.
// Caller cancellation is checked separately before permitting any fallback.
export function isTransientProviderError(error) {
  const status = Number(error?.status ?? error?.response?.status)
  const name = String(error?.name || '')
  const code = String(error?.code ?? error?.cause?.code ?? '')
  return isLLMTimeout(error) || [408, 425, 429].includes(status) || status >= 500 ||
    ['APIConnectionError', 'APIConnectionTimeoutError'].includes(name) ||
    ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
}
