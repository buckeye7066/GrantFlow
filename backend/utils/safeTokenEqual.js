import crypto from 'node:crypto'

/**
 * Constant-time comparison of two secret strings (admin / API / service tokens).
 *
 * Plain `===` on secrets short-circuits on the first differing byte, leaking the
 * shared prefix length through response timing and enabling byte-by-byte
 * recovery of a token. `crypto.timingSafeEqual` compares in constant time but
 * throws on length mismatch, so we guard length first. Token length is not
 * itself secret here (these are fixed-format keys), so the early length check is
 * an acceptable, standard trade-off (it matches the existing pattern in
 * routes/anya.js).
 *
 * Returns false for any non-string / empty / length-mismatched input.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || b.length === 0) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
