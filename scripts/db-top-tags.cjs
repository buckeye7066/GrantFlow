const Database = require('better-sqlite3')

const dbPath = process.env.DB_PATH || 'backend/data/grantflow.db'
const source = process.env.SOURCE || 'county_crawler'
const limit = Number(process.env.LIMIT || 5000)

const db = new Database(dbPath)

const rows = db
  .prepare('SELECT categories, keywords FROM funding_opportunities WHERE is_active=1 AND source=? LIMIT ?')
  .all(source, limit)

function parseJsonArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function addCount(map, value) {
  const v = String(value || '').toLowerCase().trim()
  if (!v) return
  map.set(v, (map.get(v) || 0) + 1)
}

const catCount = new Map()
const keyCount = new Map()

for (const r of rows) {
  for (const c of parseJsonArray(r.categories)) addCount(catCount, c)
  for (const k of parseJsonArray(r.keywords)) addCount(keyCount, k)
}

function top(map, n) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

console.log({
  dbPath,
  source,
  sampled_rows: rows.length,
  top_categories: top(catCount, 50),
  top_keywords: top(keyCount, 50),
})

db.close()

