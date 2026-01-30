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
  const ymdPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymdPrefix) return ymdPrefix[1]

  // Common US format "MM/DD/YYYY"
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mdy) {
    const mm = Number.parseInt(mdy[1], 10)
    const dd = Number.parseInt(mdy[2], 10)
    const yyyy = Number.parseInt(mdy[3], 10)
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yyyy >= 1900 && yyyy <= 2100) {
      return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    }
  }

  // Last resort: parseable Date → ISO date.
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

