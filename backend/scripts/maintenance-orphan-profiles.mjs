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
import { DESIGNATED_PROFILE_IDS } from '../utils/ensureDesignatedProfiles.js'

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
  //
  // NEVER treat a designated/demo profile as an orphan. These are owner-less by
  // design (source-safe: no real user_id/organization_id/email stored in the
  // repo) and are intentionally re-created by boot-time seeding. Sweeping them
  // here would tombstone + hard-delete an intentional profile, and the tombstone
  // then makes the boot seeder skip it forever — the exact "restored designated
  // profile disappears again" flap this fix eliminates.
  const designatedIds = [...DESIGNATED_PROFILE_IDS]
  const designatedPlaceholders = designatedIds.length
    ? `AND p.id NOT IN (${designatedIds.map(() => '?').join(', ')})`
    : ''
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
          ${designatedPlaceholders}
        ORDER BY p.created_at ASC
        LIMIT ?
      `,
    )
    .all(...designatedIds, limit)

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

      // Belt-and-suspenders: never delete a designated/demo profile even if the
      // query filter above is ever loosened. See the orphans query comment.
      if (DESIGNATED_PROFILE_IDS.has(pid)) {
        console.warn('[orphan-maint] skipping designated profile (never an orphan)', { profile_id: pid })
        continue
      }

      // Check for in-flight crawler jobs before deletion. If any exist, skip the profile
      // to avoid orphaning running crawl work or causing FK errors mid-crawl.
      let inFlightJobs = []
      try {
        inFlightJobs = await tx
          .prepare(
            `SELECT id, type, status FROM crawler_jobs
             WHERE profile_id = ? AND status IN ('running', 'queued', 'RUNNING', 'QUEUED')`,
          )
          .all(pid)
      } catch {
        // tolerate schema drift
      }
      if (inFlightJobs.length > 0) {
        console.warn('[orphan-maint] skipping profile with in-flight crawler jobs', {
          profile_id: pid,
          in_flight: inFlightJobs.map((j) => ({ id: j.id, type: j.type, status: j.status })),
        })
        continue
      }

      // Log/archive fingerprint data before deletion so re-evaluation history is not silently lost.
      try {
        const profileRow = await tx.prepare('SELECT * FROM profiles WHERE id = ?').get(pid)
        if (profileRow) {
          const fingerprintFields = Object.fromEntries(
            Object.entries(profileRow).filter(([k]) => k.toLowerCase().includes('fingerprint')),
          )
          if (Object.keys(fingerprintFields).length > 0) {
            console.log('[orphan-maint] archiving fingerprint before delete', {
              profile_id: pid,
              at: nowIso(),
              fingerprints: fingerprintFields,
            })
          }
        }
      } catch {
        // tolerate schema drift
      }

      // Explicitly delete from a dedicated fingerprints table if it exists.
      try {
        await tx.prepare('DELETE FROM profile_fingerprints WHERE profile_id = ?').run(pid)
      } catch {
        // tolerate schema drift (table may not exist)
      }

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

