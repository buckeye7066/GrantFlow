/**
 * Portfolio-wide primitives for workflows that may mutate an external system.
 * Product-specific stores can add states, but must preserve these semantics:
 * deterministic external identity, monotonic fencing, typed human gates,
 * reconciliation after ambiguity, and target-issued evidence before success.
 */
import crypto from 'node:crypto'

export const IRREVERSIBLE_ACTION_CONTRACT_VERSION = 'portfolio-irreversible-action-v1'

export const IRREVERSIBLE_ACTION_STATES = Object.freeze({
  PLANNED: 'planned',
  AUTHORIZED: 'authorized',
  PREPARED: 'prepared',
  HUMAN_ACTION_REQUIRED: 'human_action_required',
  READY: 'ready',
  EXECUTING: 'executing',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
  EXTERNALLY_CONFIRMED: 'externally_confirmed',
  CANCELLED: 'cancelled',
  FAILED_TERMINAL: 'failed_terminal',
})

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export function stableContractJson(value) {
  return JSON.stringify(stable(value ?? null))
}

export function contractSha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/**
 * Internal job/task ids are intentionally absent. Two internal jobs that mean
 * the same external mutation must converge on one database identity.
 */
export function buildExternalActionIdempotencyKey(namespace, identity) {
  if (!namespace || !identity || typeof identity !== 'object') throw new Error('external action identity required')
  const values = Object.values(identity).map((value) => String(value ?? '').trim())
  if (values.length === 0 || values.some((value) => !value)) throw new Error('complete external action identity required')
  return `${namespace}:${contractSha256(stableContractJson(identity))}`
}

export function validateEvidenceTimeline({ executedAt, capturedAt, checkedAt = null, now = new Date() } = {}) {
  const executed = Date.parse(executedAt)
  const captured = Date.parse(capturedAt)
  const current = new Date(now).getTime()
  if (!Number.isFinite(executed)) return { ok: false, reason: 'missing_execution_timestamp' }
  if (!Number.isFinite(captured) || captured <= executed || captured > current + 5 * 60_000) {
    return { ok: false, reason: 'invalid_capture_timestamp' }
  }
  if (checkedAt !== null && checkedAt !== undefined) {
    const checked = Date.parse(checkedAt)
    if (!Number.isFinite(checked) || checked <= executed || checked > current + 5 * 60_000) {
      return { ok: false, reason: 'invalid_independent_check_timestamp' }
    }
  }
  return { ok: true }
}
