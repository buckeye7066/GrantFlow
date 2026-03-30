/**
 * purgeMaterialChange.js
 *
 * Determines whether a funding opportunity has undergone a material change
 * that would justify a suppression-state transition.
 *
 * Rules (from the spec):
 *  - status field changed               → material (reason: status_change)
 *  - deadline field changed             → material (reason: deadline_change)
 *  - otherwise compare normalised text:
 *      material if tokenDiffRatio > 0.05 OR similarity < 0.95
 *                                         (reason: text_diff_verified)
 *  - if neither text nor fields provided → not material (safety default)
 */

import { computeTokenDiffRatio, computeSimilarity, stableTextHash } from './purgeDiffUtils.js'

// Thresholds (exported for tests)
export const TOKEN_DIFF_THRESHOLD = 0.05
export const SIMILARITY_THRESHOLD = 0.95

/**
 * Evaluate whether a change in opportunity data is material.
 *
 * @param {object} previous - snapshot of the opportunity before the re-check
 *   { status, deadline, text }  (all optional)
 * @param {object} current  - freshly-fetched state of the opportunity
 *   { status, deadline, text }  (all optional)
 *
 * @returns {{
 *   changed: boolean,
 *   reason: string | null,
 *   similarity: number,
 *   tokenDiffRatio: number,
 *   fieldChanges: object
 * }}
 */
export function detectMaterialChange(previous, current) {
  const result = {
    changed: false,
    reason: null,
    similarity: 1,
    tokenDiffRatio: 0,
    fieldChanges: {},
  }

  if (!previous || !current) {
    return result
  }

  // ── 1. Status field change ─────────────────────────────────────────────────
  const prevStatus = normalizeFieldValue(previous.status)
  const currStatus = normalizeFieldValue(current.status)
  if (prevStatus && currStatus && prevStatus !== currStatus) {
    result.changed = true
    result.reason = 'status_change'
    result.fieldChanges.status = { from: prevStatus, to: currStatus }
    // Still compute text diff for the audit record
    const { similarity, tokenDiffRatio } = compareText(previous.text, current.text)
    result.similarity = similarity
    result.tokenDiffRatio = tokenDiffRatio
    return result
  }

  // ── 2. Deadline field change ───────────────────────────────────────────────
  const prevDeadline = normalizeDeadline(previous.deadline)
  const currDeadline = normalizeDeadline(current.deadline)
  if (prevDeadline && currDeadline && prevDeadline !== currDeadline) {
    result.changed = true
    result.reason = 'deadline_change'
    result.fieldChanges.deadline = { from: prevDeadline, to: currDeadline }
    const { similarity, tokenDiffRatio } = compareText(previous.text, current.text)
    result.similarity = similarity
    result.tokenDiffRatio = tokenDiffRatio
    return result
  }

  // ── 3. Text diff ───────────────────────────────────────────────────────────
  const prevText = previous.text || ''
  const currText = current.text || ''

  if (!prevText && !currText) {
    // No text to compare — cannot determine materiality from text alone.
    return result
  }

  const prevHash = stableTextHash(prevText)
  const currHash = stableTextHash(currText)

  if (prevHash === currHash) {
    // Hashes match — content is identical, no change.
    result.similarity = 1
    result.tokenDiffRatio = 0
    return result
  }

  const { similarity, tokenDiffRatio } = compareText(prevText, currText)
  result.similarity = similarity
  result.tokenDiffRatio = tokenDiffRatio

  if (tokenDiffRatio > TOKEN_DIFF_THRESHOLD || similarity < SIMILARITY_THRESHOLD) {
    result.changed = true
    result.reason = 'text_diff_verified'
  }

  return result
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function compareText(a, b) {
  const similarity = computeSimilarity(String(a || ''), String(b || ''))
  const tokenDiffRatio = computeTokenDiffRatio(String(a || ''), String(b || ''))
  return { similarity, tokenDiffRatio }
}

function normalizeFieldValue(v) {
  if (v === null || v === undefined) return null
  return String(v).trim().toLowerCase()
}

function normalizeDeadline(v) {
  if (!v) return null
  // Accept ISO date strings and common formats; strip time component for comparison
  try {
    const d = new Date(v)
    if (isNaN(d.getTime())) return String(v).trim()
    return d.toISOString().slice(0, 10)
  } catch {
    return String(v).trim()
  }
}
