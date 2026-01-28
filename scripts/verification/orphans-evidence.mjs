#!/usr/bin/env node
import Database from 'better-sqlite3'

const DB_PATH = process.env.VERIFY_DB_PATH || 'backend/data/grantflow.verify.db'
const db = new Database(DB_PATH)

const orphanRows = db
  .prepare(
    `
      SELECT
        p.id,
        p.display_name,
        p.status,
        p.user_id,
        p.organization_id,
        (SELECT COUNT(*) FROM profile_emails pe WHERE pe.profile_id = p.id) AS email_count
      FROM profiles p
      WHERE p.user_id IS NULL
        AND p.organization_id IS NULL
        AND (SELECT COUNT(*) FROM profile_emails pe WHERE pe.profile_id = p.id) = 0
      ORDER BY p.display_name ASC
      LIMIT 50
    `,
  )
  .all()

const tombstones = db.prepare('SELECT COUNT(*) AS n FROM profile_tombstones').get()

console.log(
  JSON.stringify(
    {
      db_path: DB_PATH,
      orphan_count_sampled: orphanRows.length,
      orphans_sample: orphanRows,
      tombstones_count: Number(tombstones?.n || 0),
    },
    null,
    2,
  ),
)

