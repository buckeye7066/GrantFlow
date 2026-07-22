/**
 * amountEnrichEnv.js — shared thresholds for ENVIRONMENT-failure handling in
 * the amount-enrichment sweeps (single source of truth for BOTH the sweeps in
 * startup/enforceInvariants.js and the census in services/sam/samRegistry.js,
 * so the writer and the reader of the `unanswered_blocked` state can never
 * disagree on where "blocked" begins).
 *
 * An ENVIRONMENT failure (adapter `environment: true` — WAF 403 / 401 / 429 on
 * OUR egress) is a fact about the deploy, never the row: it consumes neither
 * the one-shot burn mark nor the normal retry budget. But "never counts"
 * originally meant "never visible": a permanently-blocked row retried forever,
 * read as green `never_read` (attempts=0), and re-occupied the bounded enrich
 * batch every run — starving valid never-attempted rows (fix-cycle
 * 2026-07-21). These thresholds give the state a boundary:
 *
 *   - ENV_MAX_ATTEMPTS consecutive environment failures (tracked in the
 *     SEPARATE `amount_enrich_env_attempts` counter, migration 151/0155) move
 *     the row to the VISIBLE `unanswered_blocked` census state — an ATTENTION
 *     row (never green, never burned, never a fabricated denial) that names
 *     its host so the owner action ("register GRANTS_GOV_API_KEY / fix
 *     egress") is actionable.
 *   - Blocked rows leave the main per-run batch and are re-probed on a slower
 *     cadence: at most ENV_REPROBE_LIMIT of them per sweep run, over and above
 *     the main budget, so they stay re-checkable (the block lifts the moment a
 *     probe succeeds — any non-environment outcome resets the counter) without
 *     ever crowding a fresh row out.
 */

function intEnv(name, fallback, { min = 0 } = {}) {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v >= min ? v : fallback
}

/** Consecutive environment failures before a row is VISIBLY `unanswered_blocked`. */
export const AMOUNT_ENRICH_ENV_MAX_ATTEMPTS = intEnv('AMOUNT_ENRICH_ENV_MAX_ATTEMPTS', 3, { min: 1 })

/** Blocked rows re-probed per sweep run (over and above the main batch budget). */
export const AMOUNT_ENRICH_ENV_REPROBE_LIMIT = intEnv('AMOUNT_ENRICH_ENV_REPROBE_LIMIT', 1, { min: 0 })

export default { AMOUNT_ENRICH_ENV_MAX_ATTEMPTS, AMOUNT_ENRICH_ENV_REPROBE_LIMIT }
