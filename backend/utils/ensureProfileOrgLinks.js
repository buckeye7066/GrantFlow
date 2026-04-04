import crypto from 'crypto'

function normalizeEmail(value) {
  const v = String(value || '').trim().toLowerCase()
  return v || null
}

function normalizeOrgName(value) {
  const v = String(value || '').replace(/\s+/g, ' ').trim()
  return v || null
}

function normalizeApplicantTypeFromProfile(primaryType) {
  const v = String(primaryType || '').trim()
  if (!v) return 'other'
  const allowed = new Set([
    'individual_need',
    'family',
    'organization',
    'nonprofit',
    'small_business',
    'student',
    'college_student',
    'high_school_student',
    'medical_assistance',
    'government',
    'other',
  ])

  // Common profile.primary_type values already align with org applicant types.
  if (allowed.has(v)) return v

  // Legacy mappings.
  if (v === 'individual') return 'individual_need'
  if (v === 'individual_profile') return 'individual_need'

  return 'other'
}

/**
 * Ensure every active profile has a valid organization_id (no orphaned profiles).
 *
 * Why:
 * - UI cards + pipeline summaries assume an org exists.
 * - Seed imports may null out organization_id to stay FK-safe, leaving orphaned profiles.
 *
 * Behavior:
 * - Idempotent: only touches profiles with missing/dangling org links.
 * - Traceable: logs a short summary.
 * - Reversible: only creates orgs when no suitable match exists.
 */
export async function ensureProfileOrgLinks(db, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 5000, 50_000))
  const includeDeleted = opts.includeDeleted === true
  const dryRun = opts.dryRun === true

  const dialect = db?.dialect || 'sqlite'
  const nowSql = dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

  const whereNotDeleted = includeDeleted ? '' : "AND (p.status IS NULL OR lower(p.status) <> 'deleted')"

  // Pull lightweight signals for org matching/creation (email + display name).
  const emailExpr =
    dialect === 'postgres'
      ? `(
          SELECT LOWER((ps.data::jsonb ->> 'email'))
          FROM profile_sections ps
          WHERE ps.profile_id = p.id AND ps.section_key = 'basic_information'
          LIMIT 1
        )`
      : `(
          SELECT LOWER(json_extract(ps.data, '$.email'))
          FROM profile_sections ps
          WHERE ps.profile_id = p.id AND ps.section_key = 'basic_information'
          LIMIT 1
        )`

  const candidates = await db
    .prepare(
      `
        SELECT
          p.id,
          p.display_name,
          p.primary_type,
          p.organization_id,
          ${emailExpr} AS email_signal,
          o.id AS org_exists
        FROM profiles p
        LEFT JOIN organizations o ON o.id = p.organization_id
        WHERE (
          p.organization_id IS NULL OR TRIM(p.organization_id) = ''
          OR (p.organization_id IS NOT NULL AND TRIM(p.organization_id) <> '' AND o.id IS NULL)
        )
        ${whereNotDeleted}
        ORDER BY COALESCE(p.updated_at, p.created_at) DESC
        LIMIT ?
      `,
    )
    .all(limit)

  const summary = {
    scanned: Array.isArray(candidates) ? candidates.length : 0,
    planned_profile_updates: 0,
    planned_org_creates: 0,
    applied_profile_updates: 0,
    applied_org_creates: 0,
    matched_by_email: 0,
    matched_by_name: 0,
    created_new_org: 0,
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.info('[profile-org-links] ok', { ...summary, dryRun })
    return { ok: true, dry_run: dryRun, ...summary }
  }

  const stmtEmailMatch = db.prepare('SELECT id FROM organizations WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1')
  const stmtNameMatch = db.prepare("SELECT id FROM organizations WHERE name = ? AND (email IS NULL OR email = '') ORDER BY updated_at DESC LIMIT 1")
  const stmtInsertOrg = db.prepare(
    `INSERT INTO organizations (id, name, email, applicant_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ${nowSql}, ${nowSql})`
  )
  const stmtUpdateProfile = db.prepare(`UPDATE profiles SET organization_id = ?, updated_at = ${nowSql} WHERE id = ?`)

  const _linkProfilesSync = (tx) => {
    for (const row of candidates) {
      const profileId = String(row?.id || '').trim()
      if (!profileId) continue

      try {
        const desiredName = normalizeOrgName(row?.display_name) || `Profile ${profileId}`
        const email = normalizeEmail(row?.email_signal)
        const applicantType = normalizeApplicantTypeFromProfile(row?.primary_type)

        let orgId = null

        if (email) {
          const emailMatch = stmtEmailMatch.get(email)
          if (emailMatch?.id) {
            orgId = String(emailMatch.id)
            summary.matched_by_email += 1
          }
        }

        if (!orgId) {
          const nameMatch = stmtNameMatch.get(desiredName)
          if (nameMatch?.id) {
            orgId = String(nameMatch.id)
            summary.matched_by_name += 1
          }
        }

        if (!orgId) {
          orgId = crypto.randomUUID()
          summary.planned_org_creates += 1

          if (!dryRun) {
            stmtInsertOrg.run(orgId, desiredName, email, applicantType)
            summary.applied_org_creates += 1
            summary.created_new_org += 1
          }
        }

        summary.planned_profile_updates += 1
        if (!dryRun) {
          stmtUpdateProfile.run(orgId, profileId)
          summary.applied_profile_updates += 1
        }
      } catch (rowErr) {
        console.warn('[profile-org-links] skipped profile due to error', { profileId, error: rowErr?.message })
      }
    }
  }

  const _linkProfilesAsync = async (tx) => {
    for (const row of candidates) {
      const profileId = String(row?.id || '').trim()
      if (!profileId) continue

      const desiredName = normalizeOrgName(row?.display_name) || `Profile ${profileId}`
      const email = normalizeEmail(row?.email_signal)
      const applicantType = normalizeApplicantTypeFromProfile(row?.primary_type)

      let orgId = null

      if (email) {
        const emailMatch = await tx
          .prepare('SELECT id FROM organizations WHERE lower(email) = ? ORDER BY updated_at DESC LIMIT 1')
          .get(email)
        if (emailMatch?.id) {
          orgId = String(emailMatch.id)
          summary.matched_by_email += 1
        }
      }

      if (!orgId) {
        const nameMatch = await tx
          .prepare("SELECT id FROM organizations WHERE name = ? AND (email IS NULL OR email = '') ORDER BY updated_at DESC LIMIT 1")
          .get(desiredName)
        if (nameMatch?.id) {
          orgId = String(nameMatch.id)
          summary.matched_by_name += 1
        }
      }

      if (!orgId) {
        orgId = crypto.randomUUID()
        summary.planned_org_creates += 1

        if (!dryRun) {
          await tx.prepare(
            `INSERT INTO organizations (id, name, email, applicant_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ${nowSql}, ${nowSql})`,
          ).run(orgId, desiredName, email, applicantType)
          summary.applied_org_creates += 1
          summary.created_new_org += 1
        }
      }

      summary.planned_profile_updates += 1
      if (!dryRun) {
        await tx.prepare(`UPDATE profiles SET organization_id = ?, updated_at = ${nowSql} WHERE id = ?`)
          .run(orgId, profileId)
        summary.applied_profile_updates += 1
      }
    }
  }

  if (dialect === 'postgres') {
    await db.withTransaction(async (tx) => { await _linkProfilesAsync(tx) })
  } else {
    await db.withTransaction((tx) => { _linkProfilesSync(tx) })
  }

  console.info('[profile-org-links] ok', { ...summary, dryRun })
  return { ok: true, dry_run: dryRun, ...summary }
}

export default ensureProfileOrgLinks
