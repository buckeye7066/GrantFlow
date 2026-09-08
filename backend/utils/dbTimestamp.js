/** SQLite CURRENT_TIMESTAMP is UTC without a suffix; PostgreSQL may return Date. */
export function parseDbTimestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string' || !value.trim()) return NaN
  const raw = value.trim()
  const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw
  return Date.parse(utc)
}
