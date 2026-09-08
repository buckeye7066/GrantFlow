export default async function up(db) {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'crawler_jobs'").get()
  if (!row?.sql || row.sql.includes("'crawler_os_discovery'")) return
  const next = row.sql.replace(/(type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type\s+IN\s*\()/i, "$1'crawler_os_discovery', ")
  if (next === row.sql) throw new Error('crawler_jobs type CHECK not found')
  const version = Number((await db.prepare('PRAGMA schema_version').get()).schema_version)
  db.unsafeMode?.(true)
  try {
    await db.exec('PRAGMA writable_schema = ON')
    await db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'crawler_jobs'").run(next)
    await db.exec(`PRAGMA schema_version = ${version + 1}`)
  } finally {
    await db.exec('PRAGMA writable_schema = OFF')
    db.unsafeMode?.(false)
  }
  const checks = await db.prepare('PRAGMA integrity_check').all()
  if (!checks.every((row) => row.integrity_check === 'ok')) throw new Error('crawler_jobs integrity check failed')
}
