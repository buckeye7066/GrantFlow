/**
 * purgeDiffUtils.js
 *
 * Deterministic text-diffing utilities for the regional purge system.
 * All functions are pure/synchronous and require no external dependencies.
 */

import crypto from 'crypto'

// ─── Text normalisation ───────────────────────────────────────────────────────

/**
 * Normalize text for comparison:
 *  - lowercase
 *  - collapse whitespace / newlines
 *  - strip HTML tags
 *  - strip common boilerplate punctuation
 */
export function normalizeText(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return raw
    .replace(/<[^>]+>/g, ' ')          // strip HTML tags
    .replace(/&[a-z]+;/gi, ' ')        // strip HTML entities
    .replace(/[^\w\s]/g, ' ')          // strip punctuation
    .toLowerCase()
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
}

// ─── Tokenisation ────────────────────────────────────────────────────────────

/**
 * Split normalised text into word tokens.
 * Returns a plain array of strings (no Set yet — callers decide).
 */
export function tokenize(normalizedText) {
  if (!normalizedText) return []
  return normalizedText.split(' ').filter(Boolean)
}

// ─── Token diff ratio ────────────────────────────────────────────────────────

/**
 * Compute the fraction of tokens that differ between two texts.
 *
 * Algorithm:
 *  1. Build multiset (token → count) for each text.
 *  2. Compute the symmetric difference of the two multisets.
 *  3. tokenDiffRatio = symmetric_diff_size / max(totalA, totalB, 1)
 *
 * A ratio of 0 means identical; 1 means completely different.
 * Threshold for "material change": ratio > 0.05 (5 %).
 */
export function computeTokenDiffRatio(textA, textB) {
  const tokensA = tokenize(normalizeText(textA))
  const tokensB = tokenize(normalizeText(textB))

  if (tokensA.length === 0 && tokensB.length === 0) return 0
  if (tokensA.length === 0 || tokensB.length === 0) return 1

  const countA = buildCountMap(tokensA)
  const countB = buildCountMap(tokensB)

  const allTokens = new Set([...countA.keys(), ...countB.keys()])
  let symDiff = 0
  for (const tok of allTokens) {
    symDiff += Math.abs((countA.get(tok) || 0) - (countB.get(tok) || 0))
  }

  const total = Math.max(tokensA.length, tokensB.length)
  return symDiff / total
}

function buildCountMap(tokens) {
  const map = new Map()
  for (const t of tokens) {
    map.set(t, (map.get(t) || 0) + 1)
  }
  return map
}

// ─── Similarity score ────────────────────────────────────────────────────────

/**
 * Compute a [0, 1] similarity score between two texts using the Sørensen–Dice
 * coefficient over bigrams of normalised tokens.
 *
 * similarity = 2 * |intersection| / (|setA| + |setB|)
 *
 * Score of 1 = identical; score of 0 = no shared bigrams.
 * Threshold for "material change": similarity < 0.95.
 */
export function computeSimilarity(textA, textB) {
  const normA = normalizeText(textA)
  const normB = normalizeText(textB)

  if (normA === normB) return 1
  if (!normA || !normB) return 0

  const bigramsA = getBigrams(normA)
  const bigramsB = getBigrams(normB)

  if (bigramsA.size === 0 && bigramsB.size === 0) return 1
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0

  let intersection = 0
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size)
}

function getBigrams(text) {
  const set = new Set()
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2))
  }
  return set
}

// ─── Stable hash ─────────────────────────────────────────────────────────────

/**
 * Compute a stable SHA-256 hex hash of the normalised text.
 * Used to quickly detect identical content without full comparison.
 */
export function stableTextHash(text) {
  const norm = normalizeText(text)
  return crypto.createHash('sha256').update(norm).digest('hex')
}
