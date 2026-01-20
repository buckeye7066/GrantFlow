const Database = require('better-sqlite3')

const dbPath = process.env.DB_PATH || 'backend/data/grantflow.db'
const db = new Database(dbPath)

function scalar(sql, params = []) {
  return db.prepare(sql).get(...params).c
}

const total = scalar("SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1")
const county = scalar("SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND source='county_crawler'")

const emptyCats = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND (categories IS NULL OR categories='' OR categories='[]')",
)
const emptyKeys = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND (keywords IS NULL OR keywords='' OR keywords='[]')",
)

const countyEmptyCats = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND source='county_crawler' AND (categories IS NULL OR categories='' OR categories='[]')",
)
const countyEmptyKeys = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND source='county_crawler' AND (keywords IS NULL OR keywords='' OR keywords='[]')",
)

console.log({
  dbPath,
  total,
  county,
  emptyCats,
  emptyKeys,
  countyEmptyCats,
  countyEmptyKeys,
})

db.close()

