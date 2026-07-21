// Signed uploader + heartbeat. Bounded, idempotent retries. The runner exposes
// NO general remote-command capability — it only POSTs signed results and
// heartbeats to two fixed coordinator endpoints.
import { buildSignedHeaders } from './sign.mjs'

async function postSigned({ url, cfg, runId, bodyObj, timestamp, fetchImpl = globalThis.fetch }) {
  const rawBody = JSON.stringify(bodyObj)
  const headers = buildSignedHeaders({
    secret: cfg.secret,
    runnerId: cfg.runnerId,
    runId,
    rawBody,
    timestamp: timestamp ?? Date.now(),
  })
  const res = await fetchImpl(url, { method: 'POST', headers, body: rawBody })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, ok: res.ok, json }
}

// Upload a result payload with bounded idempotent retries. A duplicate
// idempotency key (same run) returns 200 and is treated as success. 4xx (except
// 429) is terminal — retrying a bad request never helps.
export async function uploadResult({ cfg, payload, fetchImpl, maxAttempts = 4, sleep = defaultSleep, timestamp } = {}) {
  const url = `${cfg.coordinatorUrl.replace(/\/$/, '')}/api/eva/ingest`
  let attempt = 0
  let last = null
  while (attempt < maxAttempts) {
    attempt++
    // eslint-disable-next-line no-await-in-loop
    last = await postSigned({ url, cfg, runId: payload.run_id, bodyObj: payload, timestamp, fetchImpl }).catch((e) => ({ status: 0, ok: false, error: e?.message }))
    if (last.ok || last.status === 200 || last.status === 201) return { ok: true, status: last.status, attempts: attempt, response: last.json }
    // Terminal client errors (except rate-limit) — do not retry.
    if (last.status >= 400 && last.status < 500 && last.status !== 429) {
      return { ok: false, status: last.status, attempts: attempt, error: last.json?.error || 'client_error', terminal: true }
    }
    // Transient (5xx / 429 / network) — bounded backoff.
    if (attempt < maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(2000 * attempt, 8000))
    }
  }
  return { ok: false, status: last?.status || 0, attempts: attempt, error: last?.error || 'exhausted' }
}

// Heartbeat: sent even when testing cannot run, so a silent runner is visible.
export async function sendHeartbeat({ cfg, status = 'ok', note = null, fetchImpl, timestamp } = {}) {
  const url = `${cfg.coordinatorUrl.replace(/\/$/, '')}/api/eva/heartbeat`
  const body = { status, note, version: cfg.version, hostname_hash: null }
  try {
    const r = await postSigned({ url, cfg, runId: `heartbeat-${timestamp ?? Date.now()}`, bodyObj: body, timestamp, fetchImpl })
    return { ok: r.ok || r.status === 200, status: r.status }
  } catch (e) {
    return { ok: false, error: e?.message }
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
