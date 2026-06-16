/**
 * John — rate limiter.
 *
 * Enforces three hard caps on draft creation:
 *   - JOHN_MAX_DRAFTS_PER_24H  (rolling 24-hour cap, default 50)
 *   - JOHN_MAX_DRAFTS_PER_HOUR (rolling 60-minute cap, default 10)
 *   - JOHN_MAX_DRAFTS_PER_RUN  (per-run cap, default 50)
 *
 * Counts are queried from `john_email_drafts` (excluding rows whose
 * draft_status is 'blocked' or 'failed' — those represent attempts that
 * never produced an Outlook draft).
 *
 * Pure-ish: the only side effect is a SELECT against the db handle.
 */

import { countDraftsCreatedSince } from './johnRunStore.js'
import { BLOCK_REASONS } from './johnTypes.js'
import { getJohnConfig } from './johnOutreachSafety.js'

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR

export async function getDraftCapacity(db, config = getJohnConfig()) {
  const since24h = new Date(Date.now() - MS_PER_DAY).toISOString()
  const sinceHour = new Date(Date.now() - MS_PER_HOUR).toISOString()
  const created24h = await countDraftsCreatedSince(db, since24h)
  const createdHour = await countDraftsCreatedSince(db, sinceHour)
  const remaining24h = Math.max(0, (config.maxDraftsPer24h || 0) - created24h)
  const remainingHour = Math.max(0, (config.maxDraftsPerHour || 0) - createdHour)
  return {
    config: {
      maxPer24h: config.maxDraftsPer24h,
      maxPerHour: config.maxDraftsPerHour,
      maxPerRun: config.maxDraftsPerRun,
    },
    counts: {
      created_last_24h: created24h,
      created_last_hour: createdHour,
    },
    remaining: {
      remaining_24h: remaining24h,
      remaining_hour: remainingHour,
    },
  }
}

/**
 * Returns the maximum number of drafts the agent may attempt in this run.
 * The smaller of: per-run cap, remaining 24h capacity, remaining hourly
 * capacity, and the caller-supplied requested cap.
 */
export async function computeRunBudget(
  db,
  { requested = null, config = getJohnConfig() } = {}
) {
  const cap = await getDraftCapacity(db, config)
  let budget = config.maxDraftsPerRun || 0
  if (typeof requested === 'number' && requested >= 0) {
    budget = Math.min(budget, requested)
  }
  budget = Math.min(budget, cap.remaining.remaining_24h, cap.remaining.remaining_hour)
  budget = Math.max(0, budget)
  return {
    budget,
    capacity: cap,
    daily_limit_reached: cap.remaining.remaining_24h <= 0,
    hourly_limit_reached: cap.remaining.remaining_hour <= 0,
  }
}

/**
 * Per-attempt gate: returns { ok, reasons[] } so the agent can append
 * reasons to a safety report and skip the slot rather than abort the run.
 */
export async function checkRateGate(db, config = getJohnConfig()) {
  const cap = await getDraftCapacity(db, config)
  const reasons = []
  if (cap.remaining.remaining_24h <= 0) reasons.push(BLOCK_REASONS.DAILY_LIMIT_REACHED)
  if (cap.remaining.remaining_hour <= 0) reasons.push(BLOCK_REASONS.HOURLY_LIMIT_REACHED)
  return {
    ok: reasons.length === 0,
    reasons,
    capacity: cap,
  }
}
