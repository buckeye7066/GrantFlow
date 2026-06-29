/**
 * amyMetadata.js
 *
 * Builds the synthetic-profile metadata block Amy stamps on every record, plus
 * small deterministic helpers (run id, scenario id, seeded RNG) so a training
 * run is reproducible and fully traceable.
 *
 * The metadata block is the exact contract the spec requires and is stored as a
 * dedicated `amy_metadata` profile_sections row (authoritative) and mirrored
 * into profiles.tags (for quick scanning by Sam's cleanup sweep).
 */

import { randomUUID } from 'node:crypto'
import {
  ORIGIN_AGENT,
  PIPELINE,
  CREATED_FOR,
  BASE_TAGS,
  TTL_MIN_HOURS,
  TTL_DEFAULT_HOURS,
  TTL_MAX_HOURS,
} from './amyConstants.js'

/** Clamp a TTL (hours) into the safe 24–72h window. */
export function clampTtlHours(hours) {
  const n = Number(hours)
  if (!Number.isFinite(n)) return TTL_DEFAULT_HOURS
  return Math.max(TTL_MIN_HOURS, Math.min(TTL_MAX_HOURS, Math.round(n)))
}

/** Generate a stable, timestamped Amy run id. */
export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return `amy-${stamp}-${randomUUID().slice(0, 8)}`
}

/**
 * Build the synthetic metadata block for one profile. Matches the required
 * shape exactly so downstream tooling (Sam cleanup, Anya handoff) can rely on
 * the field names.
 */
export function buildAmyMetadata({ runId, scenarioId, ttlHours = TTL_DEFAULT_HOURS, now = new Date() }) {
  const createdAt = now instanceof Date ? now : new Date(now)
  const ttl = clampTtlHours(ttlHours)
  const expiresAt = new Date(createdAt.getTime() + ttl * 60 * 60 * 1000)
  return {
    synthetic: true,
    origin_agent: ORIGIN_AGENT,
    pipeline: PIPELINE,
    amy_run_id: runId,
    scenario_id: scenarioId,
    created_for: CREATED_FOR,
    allow_sam_cleanup: true,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    ttl_hours: ttl,
  }
}

/**
 * Tag array for profiles.tags — base markers plus run/scenario trace tags so a
 * profile can be attributed to an exact training run from the row alone.
 */
export function buildAmyTags({ runId, scenarioId }) {
  return [...BASE_TAGS, `amy_run:${runId}`, `amy_scenario:${scenarioId}`]
}

/** True if a metadata block marks a profile as expired (past expires_at). */
export function isMetadataExpired(meta, now = new Date()) {
  if (!meta || !meta.expires_at) return false
  const exp = Date.parse(meta.expires_at)
  if (!Number.isFinite(exp)) return false
  return exp <= (now instanceof Date ? now.getTime() : Date.parse(now))
}

/**
 * Tiny deterministic PRNG (mulberry32) seeded from a string, so synthetic
 * profile variation is reproducible per run id (traceable + re-runnable).
 */
export function makeSeededRng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export default {
  clampTtlHours,
  newRunId,
  buildAmyMetadata,
  buildAmyTags,
  isMetadataExpired,
  makeSeededRng,
}
