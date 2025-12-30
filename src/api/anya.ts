export type AnyaStatus = {
  status: 'idle' | 'running' | 'error'
  currentAction: null | {
    action: string
    startedAt: string
    payload?: Record<string, unknown>
  }
  lastError: null | {
    message: string
    occurredAt: string
  }
  lastAction?: AnyaLogEntry | null
}

export type AnyaLogEntry = {
  id: string
  timestamp: string
  actor: string
  action: string
  status: 'started' | 'completed' | 'failed'
  message: string
  input?: Record<string, unknown>
  data?: Record<string, unknown>
}

type AdminAction = 'scan' | 'crawl' | 'explain'

type FetchOptions = {
  token?: string | null
  signal?: AbortSignal
}

function buildHeaders(token?: string | null, contentType = false): HeadersInit {
  const headers: Record<string, string> = {}
  if (contentType) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function handleResponse<T>(res: Response): Promise<T> {
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = (payload as { error?: string })?.error ?? res.statusText
    throw new Error(message || 'Request failed')
  }
  return payload as T
}

export async function fetchStatus(options: FetchOptions = {}): Promise<AnyaStatus> {
  const res = await fetch('/api/anya/status', {
    method: 'GET',
    headers: buildHeaders(options.token),
    credentials: 'include',
    signal: options.signal,
  })
  return handleResponse<AnyaStatus>(res)
}

export async function fetchLogs(limit = 25, options: FetchOptions = {}): Promise<AnyaLogEntry[]> {
  const res = await fetch(`/api/anya/logs?limit=${Math.max(limit, 1)}`, {
    method: 'GET',
    headers: buildHeaders(options.token),
    credentials: 'include',
    signal: options.signal,
  })
  const data = await handleResponse<{ entries: AnyaLogEntry[] }>(res)
  return data.entries ?? []
}

export async function triggerAction(
  action: AdminAction,
  payload: Record<string, unknown> = {},
  options: FetchOptions = {},
) {
  const res = await fetch(`/api/anya/${action}`, {
    method: 'POST',
    headers: buildHeaders(options.token, true),
    credentials: 'include',
    body: JSON.stringify(payload),
    signal: options.signal,
  })
  return handleResponse<{ message: string }>(res)
}

