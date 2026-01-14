const Database = require('better-sqlite3')

const dbPath = process.env.DB_PATH || 'backend/data/grantflow.db'
const db = new Database(dbPath)

function scalar(sql) {
  return db.prepare(sql).get().c
}

const disability = scalar(
  "SELECT COUNT(1) c FROM funding_opportunities WHERE is_active=1 AND (categories LIKE '%disab%' OR keywords LIKE '%disab%' OR description LIKE '%disab%')",
)
const medicaid = scalar(
  "SELECT COUNT(1) c FROM funding_opportunities WHERE is_active=1 AND (categories LIKE '%medicaid%' OR keywords LIKE '%medicaid%' OR description LIKE '%medicaid%')",
)
const scholarship = scalar(
  "SELECT COUNT(1) c FROM funding_opportunities WHERE is_active=1 AND (categories LIKE '%scholar%' OR keywords LIKE '%scholar%' OR title LIKE '%Scholar%' OR description LIKE '%scholar%')",
)
const equipment = scalar(
  "SELECT COUNT(1) c FROM funding_opportunities WHERE is_active=1 AND (categories LIKE '%equip%' OR keywords LIKE '%equip%' OR title LIKE '%equipment%' OR description LIKE '%equipment%')",
)
const vehicle = scalar(
  "SELECT COUNT(1) c FROM funding_opportunities WHERE is_active=1 AND (categories LIKE '%vehic%' OR keywords LIKE '%vehic%' OR title LIKE '%van%' OR title LIKE '%vehicle%' OR description LIKE '%vehicle%')",
)

console.log({
  dbPath,
  disability,
  medicaid,
  scholarship,
  equipment,
  vehicle,
})

db.close()

