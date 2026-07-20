/**
 * directiveProfileResolver.js
 *
 * Resolves an owner-attached free-text agent directive ("focus on the Smith
 * Family Foundation profile") to a single profiles.id, so an agent can scope
 * a run to it. Deliberately conservative — the same "whole name, not one
 * token" bar this codebase already uses for Yana's lead-contact plausibility
 * gate (a shared surname or one common word is a coincidence, not an
 * identity). Returns null on zero or multiple matches; a wrong guess would
 * silently narrow an agent's run to the wrong profile, which is worse than
 * running unscoped.
 */

function significantTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
}

/**
 * @param {object} db
 * @param {string} text
 * @returns {Promise<{id: string, display_name: string} | null>}
 */
export async function resolveProfileFromDirective(db, text) {
  const raw = String(text || '').trim()
  if (!raw || !db?.prepare) return null
  const lower = raw.toLowerCase()

  let rows = []
  try {
    rows = await db.prepare(`SELECT id, display_name FROM profiles WHERE status = 'active'`).all()
  } catch {
    return null
  }
  if (!Array.isArray(rows) || !rows.length) return null

  const matches = []
  for (const row of rows) {
    const tokens = significantTokens(row.display_name)
    // Require at least 2 distinctive tokens so a single common word ("Foundation",
    // "Family") can never match alone, then require EVERY one of them to appear
    // in the directive text as a whole word.
    if (tokens.length < 2) continue
    const allPresent = tokens.every((tok) => new RegExp(`\\b${tok}\\b`).test(lower))
    if (allPresent) matches.push(row)
  }

  return matches.length === 1 ? matches[0] : null
}
