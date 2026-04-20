/**
 * Shared safe SQL identifier utilities.
 *
 * Use these helpers whenever a query needs to interpolate an identifier
 * (table name, column name, composite key set) that cannot be parameterised
 * through bind variables. Values must still be passed as parameters; only the
 * identifier/key shape is validated here against a hardcoded allowlist.
 */

/**
 * Assert that `value` is a key in `allowedMap`. Returns the mapped entry on
 * success; throws a 400 Error otherwise.
 *
 * @param {string} value - Candidate identifier from user/code input
 * @param {Record<string, any>} allowedMap - Hardcoded allowlist { identifier: metadata }
 * @param {string} [label='identifier'] - Human-readable label for error messages
 */
export function assertAllowedIdentifier(value, allowedMap, label = 'identifier') {
  const normalized = String(value || '').trim()
  if (!normalized || !Object.prototype.hasOwnProperty.call(allowedMap, normalized)) {
    const error = new Error(`Unsafe SQL ${label}: ${value}`)
    error.status = 400
    throw error
  }
  return allowedMap[normalized]
}

/**
 * Build a `col = ? AND col = ?` WHERE clause from an ordered list of key names.
 * Caller is responsible for passing matching values to the prepared statement.
 *
 * @param {string[]} keys - Column names to include in the WHERE clause
 */
export function buildEqualityWhereClause(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('At least one key is required')
  }
  // Safety: key names must look like SQL identifiers. Callers should have
  // already passed through assertAllowedKeySet, but defence in depth is cheap.
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) {
      const error = new Error(`Invalid SQL column name: ${key}`)
      error.status = 400
      throw error
    }
  }
  return keys.map((key) => `${key} = ?`).join(' AND ')
}

/**
 * Assert that an unordered set of keys matches one of the allowed sets.
 * Prevents callers from supplying arbitrary composite unique keys.
 *
 * @param {string[]} keys - Candidate key set
 * @param {string[][]} allowedSets - Allowlist of acceptable key combinations
 * @param {string} [label='key set']
 */
export function assertAllowedKeySet(keys, allowedSets, label = 'key set') {
  if (!Array.isArray(keys) || keys.length === 0) {
    const error = new Error(`Unsafe SQL ${label}: (empty)`)
    error.status = 400
    throw error
  }
  const normalized = [...keys].map(String).sort()
  const matched = allowedSets.some((set) => {
    const sorted = [...set].map(String).sort()
    return sorted.length === normalized.length && sorted.every((v, i) => v === normalized[i])
  })
  if (!matched) {
    const error = new Error(`Unsafe SQL ${label}: ${keys.join(', ')}`)
    error.status = 400
    throw error
  }
  return true
}
