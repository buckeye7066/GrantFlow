/**
 * Keeps `profile_sections` aligned with linked `organizations` rows.
 *
 * Historical note: much of the legacy intake data still lives on `organizations`.
 * Profile sections are only hydrated when an org is created/updated unless we run a restore.
 */
import crypto from 'crypto'
import { safeParseJSON } from '../utils/safeJson.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
import { CANONICAL_SECTION_DEFAULTS, canonicalSectionKeys } from '../prompts/profileSections.js'
import { COMPREHENSIVE_APPLICATION_DEFAULTS } from '../config/comprehensiveApplicationSchema.js'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('services:profileOrganizationSync')

export function parseOrganizationRow(org) {
  if (!org) return null
  return {
    ...org,
    keywords: safeParseJSON(org.keywords, []),
    focus_areas: safeParseJSON(org.focus_areas, []),
    program_areas: safeParseJSON(org.program_areas, []),
    government_assistance: safeParseJSON(org.government_assistance, []),
    disabilities: safeParseJSON(org.disabilities, []),
    target_colleges: safeParseJSON(org.target_colleges, []),
    federal_registrations: safeParseJSON(org.federal_registrations, []),
    financial_challenges: safeParseJSON(org.financial_challenges, []),
  }
}

export function normalizeEmailField(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim())
    return first ? first.trim() : ''
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

export function normalizePhoneField(value) {
  if (!value) return ''
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v.trim())
    return first ? first.trim() : ''
  }
  if (typeof value === 'string') return value.trim()
  return ''
}

function hasProfileValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function dataMatchesCanonicalDefaults(sectionKey, data) {
  const defaults =
    sectionKey === 'comprehensive_application'
      ? COMPREHENSIVE_APPLICATION_DEFAULTS
      : CANONICAL_SECTION_DEFAULTS[sectionKey] || {}
  const d = data && typeof data === 'object' ? data : {}
  for (const k of Object.keys(defaults)) {
    if (JSON.stringify(d[k]) !== JSON.stringify(defaults[k])) return false
  }
  for (const k of Object.keys(d)) {
    if (!(k in defaults)) {
      const v = d[k]
      if (v === undefined || v === null) continue
      if (typeof v === 'string' && v.trim() === '') continue
      if (Array.isArray(v) && v.length === 0) continue
      if (typeof v === 'object' && v && Object.keys(v).length === 0) continue
      return false
    }
  }
  return true
}

function mergeFillEmptyKeys(existing, candidate) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {}
  if (!candidate || typeof candidate !== 'object') return base
  for (const [k, v] of Object.entries(candidate)) {
    if (!hasProfileValue(base[k])) {
      base[k] = v
    }
  }
  return base
}

export async function ensureProfileForOrganization(db, { organizationId, displayName, primaryType, userId, createdBy }) {
  const existing = await db
    .prepare(
      `
        SELECT id
        FROM profiles
        WHERE organization_id = ?
        ORDER BY created_at ASC
        LIMIT 1
      `,
    )
    .get(organizationId)

  if (existing?.id) return existing.id

  const profileId = crypto.randomUUID()
  await db
    .prepare(
      `
        INSERT INTO profiles (
          id,
          user_id,
          display_name,
          primary_type,
          status,
          tags,
          organization_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'active', '[]', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
    .run(
      profileId,
      userId ?? null,
      displayName ?? 'New Profile',
      primaryType ?? null,
      organizationId,
      createdBy ?? null,
    )

  return profileId
}

async function ensureCanonicalSections(db, profileId, updatedBy = 'org-sync') {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, section_key) DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
        `
  const insert = db.prepare(sql)
  for (const sectionKey of canonicalSectionKeys) {
    const defaults = CANONICAL_SECTION_DEFAULTS[sectionKey] ?? {}
    await insert.run(profileId, sectionKey, JSON.stringify(defaults), updatedBy)
  }
}

export async function upsertProfileSection(db, profileId, sectionKey, data, updatedBy = 'org-sync') {
  const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, data)
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `
      : `
          INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id, section_key) DO UPDATE SET
            data = excluded.data,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `
  await db.prepare(sql).run(profileId, sectionKey, JSON.stringify(guarded.data ?? {}), updatedBy)
  return guarded
}

/**
 * Build the same section objects as syncOrganizationToProfileSections, without writing.
 */
export function buildProfileSectionCandidatesFromOrg({ orgRow, payload }) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const o = orgRow && typeof orgRow === 'object' ? orgRow : {}

  const comprehensive = { ...COMPREHENSIVE_APPLICATION_DEFAULTS, ...p }

  return {
    comprehensive_application: comprehensive,
    basic_information: {
      ...CANONICAL_SECTION_DEFAULTS.basic_information,
      full_name: p.name ?? o.name ?? '',
      email: normalizeEmailField(p.email ?? o.email),
      phone: normalizePhoneField(p.phone ?? o.phone),
      website: p.website ?? o.website ?? '',
      address: p.address ?? o.address ?? '',
      city: p.city ?? o.city ?? '',
      state: p.state ?? o.state ?? '',
      zip: p.zip ?? o.zip ?? '',
      date_of_birth: p.date_of_birth ?? '',
      age: p.age ?? null,
      notes: o.notes ?? '',
    },
    organization_details: {
      ...CANONICAL_SECTION_DEFAULTS.organization_details,
      organization_type: p.applicant_type === 'organization' ? 'organization' : p.applicant_type ?? '',
      ein: p.organization_ein ?? o.ein ?? '',
      uei: p.organization_uei ?? o.uei ?? '',
      cage_code: p.organization_cage_code ?? o.cage_code ?? '',
      annual_budget: p.annual_budget ?? o.annual_budget ?? null,
      staff_count: p.staff_count ?? o.staff_count ?? null,
      mission: p.mission ?? o.mission ?? '',
      city: p.city ?? o.city ?? '',
      state: p.state ?? o.state ?? '',
      zip: p.zip ?? o.zip ?? '',
    },
    financial_information: {
      ...CANONICAL_SECTION_DEFAULTS.financial_information,
      household_income: p.household_income ?? o.household_income ?? null,
      household_size: p.household_size ?? o.household_size ?? null,
      financial_need_level: p.financial_need_level ?? o.financial_need_level ?? '',
      low_income: Boolean(p.low_income ?? o.low_income ?? false),
      unemployed: Boolean(p.unemployed ?? o.unemployed ?? false),
      displaced_worker: Boolean(p.displaced_worker ?? o.displaced_worker ?? false),
    },
    government_assistance: {
      ...CANONICAL_SECTION_DEFAULTS.government_assistance,
      medicaid_enrolled: Boolean(p.medicaid_enrolled ?? o.medicaid_enrolled ?? false),
      medicare_recipient: Boolean(p.medicare_recipient ?? o.medicare_recipient ?? false),
      ssi_recipient: Boolean(p.ssi_recipient ?? o.ssi_recipient ?? false),
      ssdi_recipient: Boolean(p.ssdi_recipient ?? o.ssdi_recipient ?? false),
      snap_recipient: Boolean(p.snap_recipient ?? o.snap_recipient ?? false),
      tanf_recipient: Boolean(p.tanf_recipient ?? o.tanf_recipient ?? false),
      section8_housing: Boolean(p.section8_housing ?? o.section8_housing ?? false),
    },
    military_service: {
      ...CANONICAL_SECTION_DEFAULTS.military_service,
      is_veteran: Boolean(p.veteran ?? o.veteran ?? false),
      is_active_duty: Boolean(p.active_duty ?? o.active_duty ?? false),
    },
    disability_information: {
      ...CANONICAL_SECTION_DEFAULTS.disability_information,
      has_disability: Boolean(p.disabled ?? o.disabled ?? false),
      disability_types: safeParseJSON(p.disabilities ?? o.disabilities, []),
    },
    housing_situation: {
      ...CANONICAL_SECTION_DEFAULTS.housing_situation,
      financial_challenges: safeParseJSON(p.financial_challenges ?? o.financial_challenges, []),
    },
  }
}

const RESTORE_SECTION_KEYS = [
  'comprehensive_application',
  'basic_information',
  'organization_details',
  'financial_information',
  'government_assistance',
  'military_service',
  'disability_information',
  'housing_situation',
]

/**
 * For profiles already linked to an organization, fill `profile_sections` from the org row
 * without clobbering user-entered section data.
 */
export async function fillMissingProfileSectionsForProfile(db, profileId, parsedOrg, updatedBy = 'restore-org-fill') {
  const candidates = buildProfileSectionCandidatesFromOrg({
    orgRow: parsedOrg,
    payload: parsedOrg,
  })

  await ensureCanonicalSections(db, profileId, updatedBy)

  let sectionsUpdated = 0

  for (const sectionKey of RESTORE_SECTION_KEYS) {
    const candidate = candidates[sectionKey]
    if (!candidate) continue

    const row = await db
      .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
      .get(profileId, sectionKey)

    const existing = safeParseJSON(row?.data, {})
    let merged

    if (dataMatchesCanonicalDefaults(sectionKey, existing)) {
      merged = candidate
    } else {
      merged = mergeFillEmptyKeys(existing, candidate)
    }

    const before = JSON.stringify(existing)
    const after = JSON.stringify(merged)
    if (after !== before) {
      await upsertProfileSection(db, profileId, sectionKey, merged, updatedBy)
      sectionsUpdated += 1
    }
  }

  try {
    await db.prepare('UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(profileId)
  } catch {
    // ignore
  }

  return { profile_id: profileId, sections_updated: sectionsUpdated }
}

/**
 * Restore profile sections for every active profile that has an organization_id.
 */
async function selectOrganizationRowById(db, organizationId) {
  try {
    return await db
      .prepare('SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL')
      .get(organizationId)
  } catch (e) {
    const msg = String(e?.message || e)
    if (msg.includes('no such column') && msg.includes('deleted_at')) {
      return await db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId)
    }
    throw e
  }
}

export async function restoreProfileSectionsFromLinkedOrganizations(db, options = {}) {
  const dryRun = options.dryRun === true
  const limit = Math.max(1, Math.min(Number(options.limit) || 50_000, 100_000))
  const onlyOrgIds =
    Array.isArray(options.organizationIds) && options.organizationIds.length > 0
      ? new Set(options.organizationIds.map(String))
      : null
  const onlyProfileIds =
    Array.isArray(options.profileIds) && options.profileIds.length > 0
      ? new Set(options.profileIds.map(String))
      : null

  const rows = await db
    .prepare(
      `
        SELECT p.id AS profile_id, p.organization_id
        FROM profiles p
        WHERE p.organization_id IS NOT NULL
          AND TRIM(p.organization_id) <> ''
          AND (p.status IS NULL OR lower(p.status) <> 'deleted')
        ORDER BY COALESCE(p.updated_at, p.created_at) DESC
        LIMIT ?
      `,
    )
    .all(limit)

  const summary = {
    ok: true,
    dry_run: dryRun,
    scanned: rows?.length ?? 0,
    profiles_updated: 0,
    sections_updated: 0,
    skipped_no_org_row: 0,
    errors: [],
  }

  for (const row of rows || []) {
    const profileId = String(row.profile_id)
    const organizationId = String(row.organization_id)

    if (onlyProfileIds && !onlyProfileIds.has(profileId)) continue
    if (onlyOrgIds && !onlyOrgIds.has(organizationId)) continue

    try {
      const orgRaw = await selectOrganizationRowById(db, organizationId)
      if (!orgRaw) {
        summary.skipped_no_org_row += 1
        continue
      }

      const parsed = parseOrganizationRow(orgRaw)
      if (dryRun) {
        summary.profiles_updated += 1
        continue
      }

      const res = await fillMissingProfileSectionsForProfile(db, profileId, parsed, 'restore-org-bulk')
      if (res.sections_updated > 0) {
        summary.profiles_updated += 1
        summary.sections_updated += res.sections_updated
      }
    } catch (e) {
      summary.errors.push({ profile_id: profileId, organization_id: organizationId, error: e?.message || String(e) })
    }
  }

  return summary
}

export async function syncOrganizationToProfileSections(db, { organizationId, orgRow, payload, actor }) {
  const profileId = await ensureProfileForOrganization(db, {
    organizationId,
    displayName: orgRow?.name ?? payload?.name ?? 'Profile',
    primaryType: orgRow?.applicant_type ?? payload?.applicant_type ?? null,
    userId: actor?.userId ?? null,
    createdBy: actor?.userId ?? actor?.email ?? null,
  })

  await ensureCanonicalSections(db, profileId, 'org-sync')

  const p = payload && typeof payload === 'object' ? payload : {}
  const o = orgRow && typeof orgRow === 'object' ? orgRow : {}
  const candidates = buildProfileSectionCandidatesFromOrg({ orgRow: o, payload: p })

  await upsertProfileSection(db, profileId, 'comprehensive_application', candidates.comprehensive_application, 'org-sync')
  await upsertProfileSection(db, profileId, 'basic_information', candidates.basic_information, 'org-sync')
  await upsertProfileSection(db, profileId, 'organization_details', candidates.organization_details, 'org-sync')
  await upsertProfileSection(db, profileId, 'financial_information', candidates.financial_information, 'org-sync')
  await upsertProfileSection(db, profileId, 'government_assistance', candidates.government_assistance, 'org-sync')
  await upsertProfileSection(db, profileId, 'military_service', candidates.military_service, 'org-sync')
  await upsertProfileSection(db, profileId, 'disability_information', candidates.disability_information, 'org-sync')
  await upsertProfileSection(db, profileId, 'housing_situation', candidates.housing_situation, 'org-sync')

  try {
    await db.prepare('UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(profileId)
  } catch (error) {
    qualityLog.error('Failed to update profile timestamp:', error)
    throw error
  }

  return profileId
}
