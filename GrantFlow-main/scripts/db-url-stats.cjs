const Database = require('better-sqlite3')

const dbPath = process.env.DB_PATH || 'backend/data/grantflow.db'
const db = new Database(dbPath)

function scalar(sql) {
  return db.prepare(sql).get().c
}

const total = scalar("SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1")
const withAnyUrl = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND (application_url IS NOT NULL OR source_url IS NOT NULL)",
)
const withHttpUrl = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND ((application_url LIKE 'http%' ) OR (source_url LIKE 'http%'))",
)
const synthetic = scalar(
  "SELECT COUNT(*) c FROM funding_opportunities WHERE is_active=1 AND record_origin='synthetic'",
)
const missingUrl = total - withAnyUrl

console.log({
  dbPath,
  total,
  withAnyUrl,
  withHttpUrl,
  missingUrl,
  synthetic,
})

db.close()

