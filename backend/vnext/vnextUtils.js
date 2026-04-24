export function safeJsonParse(value, fallback = null) {
  if ((value === null || value === undefined)) return fallback
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed)
  } catch {
    return fallback
  }
}

export function jsonForDb(db, value) {
  if ((value === null || value === undefined)) return null
  if (db?.dialect === 'postgres') return value
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ _error: 'unserializable' })
  }
}

export function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

export function normalizeText(value) {
  return String(value ?? '').trim()
}

export function isTruthyText(value) {
  const v = normalizeText(value)
  return Boolean(v && v.toLowerCase() !== 'n/a' && v.toLowerCase() !== 'none')
}

export function tokenize(value) {
  const raw = String(value ?? '').toLowerCase()
  return raw
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
}

export function jaccard(a, b) {
  const A = new Set((a || []).filter(Boolean))
  const B = new Set((b || []).filter(Boolean))
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  const union = A.size + B.size - inter
  return union > 0 ? inter / union : 0
}

export function nowIso() {
  return new Date().toISOString()
}

export function sqlNowLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

export async function insertIgnore(db, { table, columns, values }) {
  const cols = columns.map((c) => String(c))
  const placeholders = cols.map(() => '?').join(', ')
  const colList = cols.join(', ')

  const sql =
    db?.dialect === 'postgres'
      ? `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`
      : `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`

  return await db.prepare(sql).run(...values)
}

