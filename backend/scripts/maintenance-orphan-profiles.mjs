#!/usr/bin/env node
/**
 * Admin-only one-time maintenance: hard-delete and tombstone orphan profiles.
 *
 * Definition (per mission):
 * - profiles.user_id IS NULL
 * - profiles.organization_id IS NULL
 * - no rows in profile_emails
 *
 * Safety:
 * - Requires ORPHAN_MAINTENANCE_CONFIRM=DELETE
 *
 * Usage:
 *   ORPHAN_MAINTENANCE_CONFIRM=DELETE node backend/scripts/maintenance-orphan-profiles.mjs --apply
 *   node backend/scripts/maintenance-orphan-profiles.mjs --report
 */
import process from 'node:process'

import { db } from '../db/index.js'

function parseArgs(argv) {
  const args = new Set(argv.slice(2))
  return {
    apply: args.has('--apply'),
    report: args.has('--report') || !args.has('--apply'),
    limit: (() => {
      const idx = argv.indexOf('--limit')
      if (idx === -1) return 500
      const n = Number(argv[idx + 1])
      return Number.isFinite(n) ? Math.max(1, Math.min(5000, Math.floor(n))) : 500
    })(),
  }
}

function nowIso() {
  return new Date().toISOString()
}

async function main() {
  const { apply, report, limit } = parseArgs(process.argv)
  const confirm = String(process.env.ORPHAN_MAINTENANCE_CONFIRM || '').trim().toUpperCase()
  if (apply && confirm !== 'DELETE') {
    console.error('[orphan-maint] Refusing to apply without ORPHAN_MAINTENANCE_CONFIRM=DELETE')
    process.exit(1)
  }

  // Orphans
  const orphans = await db
    .prepare(
      `
        SELECT
          p.id,
          p.display_name,
          p.status,
          p.created_at,
          (SELECT COUNT(*) FROM profile_emails pe WHERE pe.profile_id = p.id) AS email_count
        FROM profiles p
        WHERE p.user_id IS NULL
          AND p.organization_id IS NULL
          AND (SELECT COUNT(*) FROM profile_emails pe WHERE pe.profile_id = p.id) = 0
        ORDER BY p.created_at ASC
        LIMIT ?
      `,
    )
    .all(limit)

  const summary = {
    ok: true,
    mode: apply ? 'apply' : 'report',
    at: nowIso(),
    limit,
    orphan_count: (orphans || []).length,
    deleted: 0,
    tombstoned: 0,
    sample: (orphans || []).slice(0, 20),
  }

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }

  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `
          CREATE TABLE IF NOT EXISTS profile_tombstones (
            profile_id TEXT PRIMARY KEY,
            deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_by TEXT,
            reason TEXT
          )
        `,
      )
      .run()

    for (const p of orphans || []) {
      const pid = String(p.id || '').trim()
      if (!pid) continue

      // Mark deleted status first (audit-friendly), then tombstone + hard delete.
      try {
        await tx.prepare("UPDATE profiles SET status = 'deleted' WHERE id = ?").run(pid)
      } catch {
        // ignore
      }

      const ins = await tx
        .prepare(
          `
            INSERT OR IGNORE INTO profile_tombstones (profile_id, deleted_at, deleted_by, reason)
            VALUES (?, CURRENT_TIMESTAMP, ?, ?)
          `,
        )
        .run(pid, 'maintenance-orphan-profiles', 'orphan_cleanup')

      if (Number(ins?.changes || 0) > 0) summary.tombstoned += 1

      // Hard delete.
      for (const stmt of [
        ['DELETE FROM profile_documents WHERE profile_id = ?', [pid]],
        ['DELETE FROM profile_emails WHERE profile_id = ?', [pid]],
        ['DELETE FROM profile_sections WHERE profile_id = ?', [pid]],
        ['DELETE FROM grants WHERE profile_id = ?', [pid]],
        ['DELETE FROM crawler_jobs WHERE profile_id = ?', [pid]],
        ['DELETE FROM profiles WHERE id = ?', [pid]],
      ]) {
        try {
          await tx.prepare(stmt[0]).run(...stmt[1])
        } catch {
          // tolerate schema drift
        }
      }

      summary.deleted += 1
    }
  })

  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error('[orphan-maint] FAILED:', err?.stack || err)
  process.exit(1)
})

