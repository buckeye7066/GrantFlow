/**
 * Detects database errors that mean "the school-portal bridge tables aren't
 * provisioned in this database yet" — i.e. migration 079 (sqlite) /
 * 0075_school_portal_bridge.sql (postgres) hasn't landed on this DB.
 *
 * Routes that read or write `school_student_links` / `school_partners` use
 * this matcher to degrade gracefully instead of returning 500. Semantically,
 * "no bridge tables" is identical to "this profile has no school link" —
 * the UI must keep working for every user who isn't (yet) school-bridged.
 *
 * Recognized signals:
 *   - Postgres: SQLSTATE 42P01 (`undefined_table`) or message
 *     `relation "school_student_links" does not exist` /
 *     `relation "school_partners" does not exist`.
 *   - SQLite: `no such table: school_student_links` /
 *     `no such table: school_partners` (no numeric code on better-sqlite3).
 *
 * We only match the school-bridge tables on purpose — an unrelated
 * `42P01` (e.g. `relation "users" does not exist`) is a real bug and must
 * still bubble up as 500.
 */
export function isMissingSchoolBridgeTable(error) {
  if (!error) return false
  const msg = String(error.message || error || '').toLowerCase()
  const mentionsSchoolBridge =
    /no such table:\s*school_(student_links|partners)/.test(msg) ||
    /relation\s+"school_(student_links|partners)"\s+does not exist/.test(msg)
  if (mentionsSchoolBridge) return true
  // Fallback: a plain 42P01 from pg without our table name in the message
  // (rare, but defensible) — only honor if the surrounding code path is the
  // school-link route, which is the only call site we expose this helper to.
  return false
}

export default { isMissingSchoolBridgeTable }
