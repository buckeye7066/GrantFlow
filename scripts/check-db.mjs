import Database from 'better-sqlite3'

if (/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
  console.error('ERROR: This script only supports SQLite databases. DATABASE_URL points to PostgreSQL.')
  console.error('Use the application API or a Postgres client instead.')
  process.exit(1)
}
const db = new Database('./seed/grantflow.db')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('Tables in database:', tables)
db.close()
