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

// ─── Jaccard similarity ──────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two texts based on token sets.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Returns 1 for identical token sets, 0 for completely disjoint sets.
 */
export function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(normalizeText(a)))
  const setB = new Set(tokenize(normalizeText(b)))
  if (setA.size === 0 && setB.size === 0) return 1
  const intersection = [...setA].filter((token) => setB.has(token)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 1 : intersection / union
}

/**
 * Token diff ratio based on Jaccard distance: 1 − J(A, B).
 * Returns 0 for identical texts, 1 for completely different texts.
 */
export function tokenDiffRatio(a, b) {
  return 1 - jaccardSimilarity(a, b)
}

// ─── Jaro-Winkler similarity ────────────────────────────────────────────────

/**
 * Compute Jaro-Winkler similarity between two strings.
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
export function jaroWinkler(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (left === right) return 1
  if (!left.length || !right.length) return 0

  const matchDistance = Math.max(Math.floor(Math.max(left.length, right.length) / 2) - 1, 0)
  const leftMatches = new Array(left.length).fill(false)
  const rightMatches = new Array(right.length).fill(false)

  let matches = 0
  for (let i = 0; i < left.length; i += 1) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, right.length)
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j]) continue
      if (left[i] !== right[j]) continue
      leftMatches[i] = true
      rightMatches[j] = true
      matches += 1
      break
    }
  }

  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < left.length; i += 1) {
    if (!leftMatches[i]) continue
    while (!rightMatches[k]) k += 1
    if (left[i] !== right[k]) transpositions += 1
    k += 1
  }

  const m = matches
  const jaro = ((m / left.length) + (m / right.length) + ((m - transpositions / 2) / m)) / 3

  let prefix = 0
  for (let i = 0; i < Math.min(4, left.length, right.length); i += 1) {
    if (left[i] !== right[i]) break
    prefix += 1
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}
