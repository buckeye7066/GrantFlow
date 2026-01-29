/**
 * Profile Integrity Report (offline script).
 *
 * This does NOT mutate data. It reads from the configured DB and prints a summary
 * that mirrors the admin endpoint:
 *   GET /api/admin/profiles/integrity
 *
 * Run:
 *   node backend/scripts/profile-integrity-report.mjs
 */

import { db } from '../db/index.js'
import { findDuplicateProfileGroups } from '../services/profileDedupeService.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'

async function count(sql, params = []) {
  const row = await db.prepare(sql).get(...params)
  return Number(row?.count || 0)
}

async function all(sql, params = []) {
  return await db.prepare(sql).all(...params)
}

async function main() {
  const generated_at = new Date().toISOString()

  const totals = {
    profiles: await count('SELECT COUNT(*) as count FROM profiles'),
    organizations: await count('SELECT COUNT(*) as count FROM organizations'),
    users: await count('SELECT COUNT(*) as count FROM users'),
  }

  const by_status = await all(
    `
      SELECT
        COALESCE(NULLIF(TRIM(status), ''), '(unset)') AS status,
        COUNT(*) as count
      FROM profiles
      GROUP BY COALESCE(NULLIF(TRIM(status), ''), '(unset)')
      ORDER BY count DESC
    `,
  )

  const unowned = await count(
    `
      SELECT COUNT(*) as count
      FROM profiles
      WHERE user_id IS NULL OR TRIM(user_id) = ''
    `,
  )

  const orphanRows = await all(
    `
      SELECT
        p.id, p.display_name, p.primary_type, p.status, p.updated_at,
        (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) AS section_count,
        (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) AS profile_document_count,
        (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) AS document_count,
        (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) AS grant_count
      FROM profiles p
      WHERE (p.status IS NOT NULL AND lower(p.status) = 'deleted')
        AND (p.user_id IS NULL OR TRIM(p.user_id) = '')
        AND (p.organization_id IS NULL OR TRIM(p.organization_id) = '')
        AND (SELECT COUNT(*) FROM profile_sections ps WHERE ps.profile_id = p.id) < 2
        AND (SELECT COUNT(*) FROM profile_documents pd WHERE pd.profile_id = p.id) = 0
        AND (SELECT COUNT(*) FROM documents d WHERE d.profile_id = p.id) = 0
        AND (SELECT COUNT(*) FROM grants g WHERE g.profile_id = p.id) = 0
      ORDER BY p.updated_at DESC
      LIMIT 200
    `,
  )

  const orphans = (orphanRows || []).filter((r) => !isDesignatedProfileId(r?.id))

  const duplicates = await findDuplicateProfileGroups(db, {
    strategy: 'email_or_phone',
    limitGroups: 25,
    minGroupSize: 2,
    includeInactive: true,
  })

  // Human-friendly output
  console.log('[profile-integrity] report', { generated_at, totals })
  console.log('[profile-integrity] by_status', by_status)
  console.log('[profile-integrity] unowned_profiles', unowned)
  console.log('[profile-integrity] orphan_candidates_sampled', {
    sampled: orphans.length,
    sample: orphans.slice(0, 5).map((o) => ({ id: o.id, name: o.display_name, status: o.status })),
  })
  console.log('[profile-integrity] duplicate_groups_sampled', {
    sampled: duplicates?.groups?.length || 0,
    sample: (duplicates?.groups || []).slice(0, 3).map((g) => ({
      key: g.key,
      winner: g?.winner?.id,
      losers: (g?.losers || []).map((p) => p.id),
    })),
  })
}

main()
  .catch((err) => {
    console.error('[profile-integrity] failed:', err?.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      if (db?.close) await db.close()
    } catch {
      // ignore
    }
  })

