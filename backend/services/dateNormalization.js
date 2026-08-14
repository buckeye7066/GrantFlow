/**
 * Date normalization helpers
 *
 * Goal: store deadlines in ISO (YYYY-MM-DD) so SQLite DATE comparisons work.
 * This must be deterministic, lightweight, and safe on unknown formats.
 */

export function normalizeDateToIso(value) {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null

  // Grants.gov sometimes returns "YYYY-MM-DD-00-00-00" (keep date portion).
  const ymdPrefix = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (ymdPrefix) {
    const yyyy = Number.parseInt(ymdPrefix[1], 10)
    const mm = Number.parseInt(ymdPrefix[2], 10)
    const dd = Number.parseInt(ymdPrefix[3], 10)
    if (yyyy >= 1900 && yyyy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const testDate = new Date(Date.UTC(yyyy, mm - 1, dd))
      if (testDate.getUTCFullYear() === yyyy && testDate.getUTCMonth() === mm - 1 && testDate.getUTCDate() === dd) {
        return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
      }
    }
    return null
  }

  // Common US format "MM/DD/YYYY"
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdy) {
    const mm = Number.parseInt(mdy[1], 10)
    const dd = Number.parseInt(mdy[2], 10)
    const yyyy = Number.parseInt(mdy[3], 10)
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy >= 1900 && yyyy <= 2100) {
      const testDate = new Date(yyyy, mm - 1, dd)
      if (testDate.getFullYear() !== yyyy || testDate.getMonth() !== mm - 1 || testDate.getDate() !== dd) return null
      return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    }
    // Range check failed for a string that matched MM/DD/YYYY pattern — reject
    // rather than falling through to the permissive last-resort parser.
    return null
  }

  // Last resort: parseable Date → ISO date.
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  const year = parsed.getUTCFullYear()
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0')
  const day = String(parsed.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

