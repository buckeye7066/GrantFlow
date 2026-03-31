const MAX_ENTRIES = Number(process.env.REQUEST_ID_ERROR_STORE_MAX || 250)

const store = new Map()

function normalizeRequestId(value) {
  const s = String(value || '').trim()
  return s || null
}

function truncate(text, limit = 4000) {
  const raw = String(text || '')
  if (raw.length <= limit) return raw
  return `${raw.slice(0, limit - 1)}…`
}

function pruneIfNeeded() {
  let iterations = 0
  while (store.size > MAX_ENTRIES && iterations < MAX_ENTRIES) {
    const firstKey = store.keys().next().value
    if (!firstKey) break
    store.delete(firstKey)
    iterations++
  }
}

export function recordRequestError({ requestId, path, method, statusCode, message, stack }) {
  const id = normalizeRequestId(requestId)
  if (!id) return

  const now = Date.now()
  const TTL = 24 * 60 * 60 * 1000 // 24 hours
  
  // Clean expired entries
  for (const [key, value] of store.entries()) {
    if (now - new Date(value.occurred_at).getTime() > TTL) {
      store.delete(key)
    }
  }
  
  store.set(id, {
    request_id: id,
    occurred_at: new Date().toISOString(),
    path: path ? String(path) : null,
    method: method ? String(method) : null,
    status_code: Number(statusCode) || 500,
    message: truncate(message, 2000),
    stack: stack ? truncate(stack, 8000) : null,
  })

  pruneIfNeeded()
}

export function getRequestError(requestId) {
  const id = normalizeRequestId(requestId)
  if (!id) return null
  return store.get(id) ?? null
}

