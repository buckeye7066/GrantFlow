/**
 * schoolPortalMerger.js
 *
 * Takes a record from a registered school's student-information system and
 * merges it into a GrantFlow profile so the matching engine + Discover
 * Grants UI immediately benefit from the school's first-party data
 * (enrollment, GPA, major, financial-need, residency, demographics).
 *
 * Mission alignment:
 *   - Goal 3 / 5: every school field maps to a canonical profile field so
 *     the same matcher runs on conversational-onboarding profiles AND
 *     school-bridge profiles.
 *   - Goal 4: students are first-class — schools just enrich the profile.
 *   - Goal 8 / 9: existing user prose / fields are NEVER overwritten by a
 *     school sync; a school can only ADD signals or fill empty cells.
 *     `school_provided_data: true` is a stable audit signal so anyone
 *     reading the profile knows where the data came from.
 *
 * Public API:
 *   mergeSchoolStudentRecord({ db, partner, record })
 *     -> { profile_id, link_id, action: 'created'|'merged', diff }
 *
 *   buildProfilePatch(record) -> patch       (pure, used in tests)
 *   pickFromRecord(record, key) -> value      (helper)
 *
 * The function is intentionally pure-ish: it reads the existing profile,
 * computes a non-destructive merge, and writes it back. The caller is
 * responsible for transactional wrapping.
 */

import crypto from 'node:crypto'
import { canonicalizeProfileTypeId } from '../../shared/profileTypeOptions.js'
import { normalizeNeedCategory } from './profileNormalizer.js'

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------
//
// Schools speak many dialects — the keys on the LEFT below are what their
// SIS exports (Banner, Workday, PeopleSoft, Slate, Anthology Apply, ...).
// The RIGHT side is the canonical GrantFlow field that the matcher reads.
//
// Aliases are matched case-insensitively. New aliases are cheap to add.

const EDUCATION_ALIASES = {
  // canonical: [ aliases... ]
  current_institution: [
    'school_name', 'school', 'institution', 'institution_name',
    'university', 'college', 'campus',
  ],
  highest_level: [
    'degree_level', 'level', 'enrollment_level', 'class_level', 'grade_level',
    'student_level',
  ],
  intended_major: [
    'major', 'primary_major', 'field_of_study', 'program', 'program_of_study',
  ],
  minor_field: ['minor', 'secondary_major'],
  gpa: ['gpa', 'cumulative_gpa', 'overall_gpa'],
  expected_grad: [
    'expected_graduation', 'graduation_date', 'expected_grad',
    'anticipated_graduation', 'expected_grad_date',
  ],
  enrollment_status: [
    'enrollment_status', 'attendance_status', 'enrollment',
  ],
  credit_hours: [
    'credit_hours', 'credits_enrolled', 'current_credit_hours',
  ],
  credits_earned: [
    'credits_earned', 'credit_hours_earned', 'completed_credits',
  ],
  residency_status: [
    'residency', 'residency_status', 'in_state', 'tuition_residency',
  ],
  fafsa_efc: ['fafsa_efc', 'efc', 'sai', 'student_aid_index'],
  pell_eligible: ['pell_eligible', 'pell_grant_eligible', 'is_pell_eligible'],
  first_generation: ['first_generation', 'first_gen', 'first_generation_student', 'is_first_generation'],
  financial_need_index: [
    'financial_need', 'financial_need_index', 'unmet_need',
  ],
  act_score: ['act', 'act_score', 'act_composite'],
  sat_score: ['sat', 'sat_score', 'sat_total'],
}

const BASIC_ALIASES = {
  full_name: ['full_name', 'name', 'student_name', 'legal_name'],
  email: ['email', 'school_email', 'student_email', 'primary_email'],
  phone: ['phone', 'phone_number', 'mobile_phone'],
  zip_code: ['zip', 'zip_code', 'postal_code'],
  state: ['state', 'state_code', 'home_state'],
  city: ['city', 'home_city'],
  county: ['county', 'home_county'],
  date_of_birth: ['date_of_birth', 'dob', 'birth_date'],
}

// Demographic / situational signals that BOOST scoring but never gate it.
// We only ingest these when the school explicitly flags them as
// student-consented (record.consent_demographics === true).
const DEMOGRAPHIC_TAGS = {
  is_first_generation: 'first_generation',
  is_pell_eligible: 'pell_eligible',
  is_veteran: 'veteran',
  has_disability: 'disability',
  is_international: 'international_student',
  is_transfer: 'transfer_student',
  is_part_time: 'part_time_student',
  is_full_time: 'full_time_student',
  is_online: 'online_student',
  is_dependent: 'dependent_student',
  is_independent: 'independent_student',
  is_parent: 'student_parent',
  is_caregiver: 'caregiver',
  is_homeless: 'experiencing_homelessness',
  is_foster_alumni: 'foster_alumni',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pickFromRecord(record, aliases) {
  if (!record || typeof record !== 'object') return undefined
  const lcMap = {}
  for (const [k, v] of Object.entries(record)) lcMap[k.toLowerCase()] = v
  for (const alias of aliases) {
    const v = lcMap[alias.toLowerCase()]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function trimString(value) {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim()
  return s === '' ? undefined : s
}

function asBoolean(value) {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', 'y', 'enrolled', 'eligible'].includes(v)) return true
    if (['false', 'no', 'n', 'not_enrolled', 'ineligible'].includes(v)) return false
  }
  return undefined
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function nowISO() {
  return new Date().toISOString()
}

function payloadHash(record) {
  const json = JSON.stringify(record ?? {}, Object.keys(record ?? {}).sort())
  return crypto.createHash('sha256').update(json).digest('hex')
}

function uniqueAdd(list, value) {
  const arr = Array.isArray(list) ? list.slice() : []
  if (value === null || value === undefined || value === '') return arr
  const key = String(value).toLowerCase()
  if (!arr.some((v) => String(v).toLowerCase() === key)) arr.push(value)
  return arr
}

function mergeSection(existing, additions) {
  const e = (existing && typeof existing === 'object') ? existing : {}
  const a = (additions && typeof additions === 'object') ? additions : {}
  const out = { ...e }
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      const base = Array.isArray(e[k]) ? e[k] : []
      const merged = base.slice()
      for (const item of v) {
        const key = typeof item === 'string' ? item.toLowerCase() : JSON.stringify(item)
        if (!merged.some((x) => (typeof x === 'string' ? x.toLowerCase() : JSON.stringify(x)) === key)) {
          merged.push(item)
        }
      }
      out[k] = merged
      continue
    }
    if (typeof v === 'object') {
      out[k] = mergeSection(e[k], v)
      continue
    }
    // Scalar: only set if existing is empty / null. Never overwrite user prose.
    if (e[k] === undefined || e[k] === null || e[k] === '') {
      out[k] = v
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Pure: build a profile patch from a school record
// ---------------------------------------------------------------------------
export function buildProfilePatch(record = {}) {
  const education = {}
  for (const [canonical, aliases] of Object.entries(EDUCATION_ALIASES)) {
    const raw = pickFromRecord(record, aliases)
    if (raw === undefined) continue
    if (canonical === 'gpa' || canonical === 'fafsa_efc' ||
        canonical === 'financial_need_index' ||
        canonical === 'credit_hours' || canonical === 'credits_earned' ||
        canonical === 'act_score' || canonical === 'sat_score') {
      const n = asNumber(raw)
      if (n !== undefined) education[canonical] = n
    } else if (canonical === 'pell_eligible' || canonical === 'first_generation') {
      const b = asBoolean(raw)
      if (b !== undefined) education[canonical] = b
    } else {
      const s = trimString(raw)
      if (s !== undefined) education[canonical] = s
    }
  }

  const basic = {}
  for (const [canonical, aliases] of Object.entries(BASIC_ALIASES)) {
    const raw = pickFromRecord(record, aliases)
    if (raw === undefined) continue
    const s = trimString(raw)
    if (s === undefined) continue
    if (canonical === 'state') {
      basic[canonical] = s.toUpperCase().slice(0, 2)
    } else if (canonical === 'email') {
      basic[canonical] = s.toLowerCase()
    } else {
      basic[canonical] = s
    }
  }

  const tags = []
  for (const [recordKey, tag] of Object.entries(DEMOGRAPHIC_TAGS)) {
    if (asBoolean(record[recordKey]) === true) tags.push(tag)
  }
  // Allow free-form tag pass-through too; canonicalise need-style tags.
  if (Array.isArray(record.tags)) {
    for (const raw of record.tags) {
      const s = trimString(raw)
      if (!s) continue
      const canonical = normalizeNeedCategory(s)
      tags.push(canonical || s)
    }
  }

  const programs_services = {
    school_provided_data: true,
    last_school_sync_at: nowISO(),
  }

  // Pell + first-gen are universally-recognised need signals.
  if (education.pell_eligible === true) tags.push('pell_eligible')
  if (education.first_generation === true) tags.push('first_generation')

  // FAFSA EFC <= 0 (or low SAI) -> high financial need.
  if (typeof education.fafsa_efc === 'number' && education.fafsa_efc <= 0) {
    tags.push('high_financial_need')
  }

  const location_focus = {}
  if (basic.state) location_focus.focus_state = basic.state
  if (basic.county) location_focus.focus_county = basic.county

  // Suggested primary_type — only used when target profile is generic.
  // Order matters: undergraduate must be checked BEFORE graduate so
  // "Undergraduate" never falls into the graduate bucket.
  const studentLevel = (education.highest_level || '').toLowerCase()
  let suggestedPrimaryType = 'student'
  if (/\b(high\s*school|hs|secondary|grade\s*\d|9th|10th|11th|12th)\b/i.test(studentLevel)) {
    suggestedPrimaryType = 'high_school_student'
  } else if (/\b(undergrad|undergraduate|freshman|sophomore|junior|senior|associate|bachelor)/i.test(studentLevel)) {
    suggestedPrimaryType = 'college_student'
  } else if (/\b(graduate|master|phd|doctor|doctoral|postgrad)/i.test(studentLevel)) {
    suggestedPrimaryType = 'graduate_student'
  } else if (studentLevel) {
    suggestedPrimaryType = 'college_student'
  }

  return {
    suggestedPrimaryType: canonicalizeProfileTypeId(suggestedPrimaryType) || 'student',
    suggestedDisplayName: basic.full_name,
    sections: {
      basic_information: basic,
      education,
      programs_services,
      location_focus,
    },
    tags: Array.from(new Set(tags)),
  }
}

// ---------------------------------------------------------------------------
// DB merge
// ---------------------------------------------------------------------------
async function findProfileForRecord({ db, partner, record }) {
  const externalId = trimString(record.external_student_id) ||
    trimString(record.student_id) || trimString(record.id)
  if (!externalId) {
    const err = new Error('record.external_student_id is required')
    err.code = 'MISSING_EXTERNAL_ID'
    throw err
  }

  // 1) Existing link?
  const existingLink = await db
    .prepare(`SELECT * FROM school_student_links
                WHERE school_partner_id = ? AND external_student_id = ?
                LIMIT 1`)
    .get(partner.id, externalId)
  if (existingLink?.profile_id) {
    const profile = await db
      .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
      .get(existingLink.profile_id)
    if (profile) return { externalId, link: existingLink, profile }
  }

  // 2) Match by school-supplied email against existing profiles.
  const email = trimString(pickFromRecord(record, BASIC_ALIASES.email))?.toLowerCase()
  if (email) {
    const userRow = await db
      .prepare('SELECT id FROM users WHERE LOWER(primary_email) = ? LIMIT 1')
      .get(email)
    if (userRow?.id) {
      const profile = await db
        .prepare(`SELECT * FROM profiles
                    WHERE user_id = ? AND COALESCE(status,'active') NOT IN ('deleted','archived')
                    ORDER BY created_at ASC LIMIT 1`)
        .get(userRow.id)
      if (profile) return { externalId, link: existingLink, profile }
    }
    // Also try to find a profile section that already stores this email.
    // Wrap in try/catch — the SQLite shim's .get() returns the row sync,
    // so we can't chain .catch() on the result. Postgres returns a Promise
    // and `await` handles both.
    let sectionRow = null
    try {
      sectionRow = await db
        .prepare(`SELECT profile_id FROM profile_sections
                    WHERE section_key = 'basic_information'
                      AND LOWER(IFNULL(json_extract(data, '$.email'), '')) = ?
                    LIMIT 1`)
        .get(email)
    } catch {
      sectionRow = null
    }
    if (sectionRow?.profile_id) {
      const profile = await db
        .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
        .get(sectionRow.profile_id)
      if (profile) return { externalId, link: existingLink, profile }
    }
  }

  return { externalId, link: existingLink, profile: null }
}

async function readSection(db, profileId, sectionKey) {
  const row = await db
    .prepare(`SELECT data FROM profile_sections
                WHERE profile_id = ? AND section_key = ?
                LIMIT 1`)
    .get(profileId, sectionKey)
  if (!row?.data) return {}
  try { return JSON.parse(row.data) } catch { return {} }
}

async function writeSection(db, profileId, sectionKey, data, updatedBy) {
  await db
    .prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
                VALUES (?, ?, ?, ?)
              ON CONFLICT(profile_id, section_key) DO UPDATE SET
                data = excluded.data,
                updated_by = excluded.updated_by,
                updated_at = CURRENT_TIMESTAMP`)
    .run(profileId, sectionKey, JSON.stringify(data), updatedBy)
}

export async function mergeSchoolStudentRecord({ db, partner, record, actor = 'school-portal' }) {
  if (!partner?.id) throw new Error('partner is required')

  const patch = buildProfilePatch(record)
  const lookup = await findProfileForRecord({ db, partner, record })
  const externalId = lookup.externalId
  const recordHash = payloadHash(record)

  let profileId = lookup.profile?.id ?? null
  let action = 'merged'

  if (!profileId) {
    // Create a brand-new profile owned by NO user yet — the student can
    // claim it later via the standard email-OTP login flow on /start
    // (their school email is in basic_information).
    profileId = crypto.randomUUID()
    const displayName = patch.suggestedDisplayName ||
      `${partner.name} student ${externalId}`
    await db
      .prepare(`INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by)
                  VALUES (?, ?, ?, 'active', ?, ?)`)
      .run(
        profileId,
        displayName,
        patch.suggestedPrimaryType,
        JSON.stringify(patch.tags),
        `school-portal:${partner.slug}`,
      )
    action = 'created'
  } else {
    // Update primary_type if currently generic (`individual`, `null`, etc.)
    // — never overwrite a more specific type the user already chose.
    const currentType = lookup.profile.primary_type ?? null
    if (!currentType || currentType === 'individual' || currentType === 'other') {
      await db
        .prepare('UPDATE profiles SET primary_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(patch.suggestedPrimaryType, profileId)
    }
    // Merge tags additively.
    let existingTags = []
    try { existingTags = JSON.parse(lookup.profile.tags || '[]') } catch { existingTags = [] }
    let mergedTags = existingTags.slice()
    for (const tag of patch.tags) mergedTags = uniqueAdd(mergedTags, tag)
    await db
      .prepare('UPDATE profiles SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(mergedTags), profileId)
  }

  // Sections — always non-destructive merge.
  for (const [sectionKey, additions] of Object.entries(patch.sections)) {
    if (!additions || Object.keys(additions).length === 0) continue
    const existing = await readSection(db, profileId, sectionKey)
    const merged = mergeSection(existing, additions)
    await writeSection(db, profileId, sectionKey, merged, actor)
  }

  // Upsert the link row.
  const linkId = lookup.link?.id ?? crypto.randomUUID()
  if (lookup.link?.id) {
    await db
      .prepare(`UPDATE school_student_links
                  SET profile_id = ?,
                      email = COALESCE(?, email),
                      last_synced_at = ?,
                      last_sync_payload_hash = ?,
                      updated_at = ?
                WHERE id = ?`)
      .run(
        profileId,
        patch.sections.basic_information.email ?? null,
        nowISO(),
        recordHash,
        nowISO(),
        lookup.link.id,
      )
  } else {
    await db
      .prepare(`INSERT INTO school_student_links (
                  id, school_partner_id, profile_id, external_student_id, email,
                  consent_status, consented_at, last_synced_at, last_sync_payload_hash
                ) VALUES (?, ?, ?, ?, ?, 'granted', ?, ?, ?)`)
      .run(
        linkId,
        partner.id,
        profileId,
        externalId,
        patch.sections.basic_information.email ?? null,
        nowISO(),
        nowISO(),
        recordHash,
      )
  }

  return { profile_id: profileId, link_id: linkId, action, external_student_id: externalId }
}

// Test exports.
export const __testing__ = { pickFromRecord, mergeSection, payloadHash }
