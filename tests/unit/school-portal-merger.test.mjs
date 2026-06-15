/**
 * Unit tests for backend/services/schoolPortalMerger.js
 *
 * Covers:
 *   - buildProfilePatch field mapping (canonical names + alias resolution)
 *   - non-destructive merge (existing scalars never overwritten)
 *   - tag canonicalisation + demographic flag mapping
 *   - DB-level mergeSchoolStudentRecord against an in-memory shim
 *   - external_student_id requirement
 *
 * No real database — we use a tiny in-memory `prepare(...).get/.all/.run`
 * shim that implements just enough of the production better-sqlite3 API
 * to drive the merger end-to-end.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProfilePatch,
  mergeSchoolStudentRecord,
} from '../../backend/services/schoolPortalMerger.js'

// ---------------------------------------------------------------------------
// In-memory DB shim (just enough surface area for the merger)
// ---------------------------------------------------------------------------
function makeMemoryDb() {
  const tables = {
    profiles: new Map(),
    profile_sections: new Map(),         // key: `${profile_id}::${section_key}`
    school_partners: new Map(),
    school_partner_api_keys: new Map(),
    school_student_links: new Map(),
    users: new Map(),
  }

  function jsonExtractEmail(data) {
    try { return (JSON.parse(data ?? '{}').email ?? '').toLowerCase() } catch { return '' }
  }

  function prepare(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim()
    return {
      get: (...params) => exec(text, params, 'get'),
      all: (...params) => exec(text, params, 'all'),
      run: (...params) => exec(text, params, 'run'),
    }
  }

  function exec(sql, params, mode) {
    // school_student_links lookups
    if (sql.startsWith('SELECT * FROM school_student_links WHERE school_partner_id = ? AND external_student_id = ?')) {
      const [partnerId, externalId] = params
      for (const row of tables.school_student_links.values()) {
        if (row.school_partner_id === partnerId && row.external_student_id === externalId) {
          return row
        }
      }
      return undefined
    }
    if (sql.startsWith('SELECT * FROM profiles WHERE id = ?')) {
      return tables.profiles.get(params[0])
    }
    if (sql.startsWith('SELECT id FROM users WHERE LOWER(primary_email) = ?')) {
      const email = String(params[0] || '').toLowerCase()
      for (const row of tables.users.values()) {
        if (String(row.primary_email || '').toLowerCase() === email) return { id: row.id }
      }
      return undefined
    }
    if (sql.startsWith("SELECT * FROM profiles WHERE user_id = ?")) {
      const [userId] = params
      for (const row of tables.profiles.values()) {
        if (row.user_id === userId && (row.status ?? 'active') !== 'deleted' && (row.status ?? 'active') !== 'archived') {
          return row
        }
      }
      return undefined
    }
    if (sql.startsWith("SELECT profile_id FROM profile_sections WHERE section_key = 'basic_information'")) {
      const email = String(params[0] || '').toLowerCase()
      for (const row of tables.profile_sections.values()) {
        if (row.section_key !== 'basic_information') continue
        if (jsonExtractEmail(row.data) === email) return { profile_id: row.profile_id }
      }
      return undefined
    }
    if (sql.startsWith('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')) {
      const [profileId, sectionKey] = params
      return tables.profile_sections.get(`${profileId}::${sectionKey}`)
    }
    if (sql.startsWith('INSERT INTO profile_sections')) {
      const [profileId, sectionKey, data, updatedBy] = params
      tables.profile_sections.set(`${profileId}::${sectionKey}`, {
        profile_id: profileId, section_key: sectionKey, data, updated_by: updatedBy,
      })
      return { changes: 1 }
    }
    if (sql.startsWith('INSERT INTO profiles')) {
      const [id, displayName, primaryType, tags, createdBy] = params
      tables.profiles.set(id, {
        id, display_name: displayName, primary_type: primaryType,
        status: 'active', tags, created_by: createdBy,
      })
      return { changes: 1 }
    }
    if (sql.startsWith('UPDATE profiles SET primary_type = ?')) {
      const [primaryType, profileId] = params
      const row = tables.profiles.get(profileId)
      if (row) row.primary_type = primaryType
      return { changes: row ? 1 : 0 }
    }
    if (sql.startsWith('UPDATE profiles SET tags = ?')) {
      const [tags, profileId] = params
      const row = tables.profiles.get(profileId)
      if (row) row.tags = tags
      return { changes: row ? 1 : 0 }
    }
    if (sql.startsWith('INSERT INTO school_student_links')) {
      const [id, partnerId, profileId, externalId, email, _consent, _consentedAt, lastSyncedAt, hash] = params
      tables.school_student_links.set(id, {
        id,
        school_partner_id: partnerId,
        profile_id: profileId,
        external_student_id: externalId,
        email,
        consent_status: 'granted',
        last_synced_at: lastSyncedAt,
        last_sync_payload_hash: hash,
      })
      return { changes: 1 }
    }
    if (sql.startsWith('UPDATE school_student_links SET profile_id = ?')) {
      const [profileId, email, lastSyncedAt, hash, updatedAt, id] = params
      const row = tables.school_student_links.get(id)
      if (row) {
        row.profile_id = profileId
        if (email) row.email = email
        row.last_synced_at = lastSyncedAt
        row.last_sync_payload_hash = hash
        row.updated_at = updatedAt
      }
      return { changes: row ? 1 : 0 }
    }
    throw new Error(`unhandled SQL in test shim: ${sql}`)
  }

  return { prepare, tables }
}

// ---------------------------------------------------------------------------
// buildProfilePatch
// ---------------------------------------------------------------------------
test('buildProfilePatch maps Banner-style record onto canonical fields', () => {
  const patch = buildProfilePatch({
    external_student_id: 'U12345678',
    institution_name: 'University of Memphis',
    school_email: 'jane.doe@memphis.edu',
    full_name: 'Jane Doe',
    student_level: 'Undergraduate',
    primary_major: 'Nursing',
    minor: 'Spanish',
    cumulative_gpa: '3.42',
    enrollment_status: 'full_time',
    expected_graduation: '2027-05-15',
    home_state: 'tn',
    home_city: 'Memphis',
    zip_code: '38103',
    is_pell_eligible: true,
    is_first_generation: 'yes',
    fafsa_efc: 0,
    tags: ['scholarship', 'tuition'],
  })

  assert.equal(patch.suggestedPrimaryType, 'college_student')
  assert.equal(patch.suggestedDisplayName, 'Jane Doe')

  const edu = patch.sections.education
  assert.equal(edu.current_institution, 'University of Memphis')
  assert.equal(edu.intended_major, 'Nursing')
  assert.equal(edu.minor_field, 'Spanish')
  assert.equal(edu.gpa, 3.42)
  assert.equal(edu.expected_grad, '2027-05-15')
  assert.equal(edu.enrollment_status, 'full_time')
  assert.equal(edu.fafsa_efc, 0)
  assert.equal(edu.pell_eligible, true)
  assert.equal(edu.first_generation, true)

  const basic = patch.sections.basic_information
  assert.equal(basic.email, 'jane.doe@memphis.edu')
  assert.equal(basic.full_name, 'Jane Doe')
  assert.equal(basic.state, 'TN')
  assert.equal(basic.city, 'Memphis')
  assert.equal(basic.zip_code, '38103')

  assert.equal(patch.sections.location_focus.focus_state, 'TN')

  // Pell + first-gen + EFC <= 0 must be tagged for the matcher.
  const tags = new Set(patch.tags)
  assert.ok(tags.has('pell_eligible'))
  assert.ok(tags.has('first_generation'))
  assert.ok(tags.has('high_financial_need'))
  // Need-style aliases canonicalise via NEED_ALIAS_MAP.
  assert.ok(tags.has('education'))

  assert.equal(patch.sections.programs_services.school_provided_data, true)
  assert.ok(patch.sections.programs_services.last_school_sync_at)
})

test('buildProfilePatch suggests graduate / high-school types from level', () => {
  const grad = buildProfilePatch({
    external_student_id: 'g1',
    student_level: 'Graduate',
  })
  assert.equal(grad.suggestedPrimaryType, 'graduate_student')

  const hs = buildProfilePatch({
    external_student_id: 'hs1',
    student_level: 'High School Senior',
  })
  assert.equal(hs.suggestedPrimaryType, 'high_school_student')
})

test('buildProfilePatch ignores empty / nullish fields', () => {
  const patch = buildProfilePatch({
    external_student_id: 'x',
    school_name: '',
    gpa: null,
    intended_major: '   ',
    fafsa_efc: 'not-a-number',
  })
  assert.deepEqual(patch.sections.education, {})
  assert.equal(patch.suggestedDisplayName, undefined)
})

// ---------------------------------------------------------------------------
// mergeSchoolStudentRecord — DB level
// ---------------------------------------------------------------------------
test('mergeSchoolStudentRecord creates a new profile when no link / email match', async () => {
  const db = makeMemoryDb()
  const partner = { id: 'p1', slug: 'memphis', name: 'University of Memphis' }
  const result = await mergeSchoolStudentRecord({
    db,
    partner,
    record: {
      external_student_id: 'U001',
      school_email: 'new.student@memphis.edu',
      full_name: 'New Student',
      student_level: 'Undergraduate',
      gpa: '3.1',
    },
  })
  assert.equal(result.action, 'created')
  assert.ok(result.profile_id)
  assert.ok(result.link_id)
  assert.equal(result.external_student_id, 'U001')

  const profile = db.tables.profiles.get(result.profile_id)
  assert.equal(profile.primary_type, 'college_student')
  assert.equal(profile.display_name, 'New Student')
  assert.equal(profile.created_by, 'school-portal:memphis')

  const educationSection = db.tables.profile_sections.get(`${result.profile_id}::education`)
  const eduData = JSON.parse(educationSection.data)
  assert.equal(eduData.gpa, 3.1)

  const link = db.tables.school_student_links.get(result.link_id)
  assert.equal(link.consent_status, 'granted')
  assert.equal(link.email, 'new.student@memphis.edu')
})

test('mergeSchoolStudentRecord merges into an existing profile by email and never overwrites scalars', async () => {
  const db = makeMemoryDb()
  const partner = { id: 'p2', slug: 'state-cc', name: 'State CC' }

  // Pre-existing user + profile + sections (e.g. created via /start onboarding).
  db.tables.users.set('u1', { id: 'u1', primary_email: 'jane@cc.edu' })
  const profileId = 'profile-1'
  db.tables.profiles.set(profileId, {
    id: profileId,
    user_id: 'u1',
    display_name: 'Jane (manual)',
    primary_type: 'individual',
    status: 'active',
    tags: '["food"]',
  })
  db.tables.profile_sections.set(`${profileId}::education`, {
    profile_id: profileId,
    section_key: 'education',
    data: JSON.stringify({ gpa: 3.9, intended_major: 'Self-entered' }),
  })
  db.tables.profile_sections.set(`${profileId}::basic_information`, {
    profile_id: profileId,
    section_key: 'basic_information',
    data: JSON.stringify({ email: 'jane@cc.edu', full_name: 'Jane Original' }),
  })

  const result = await mergeSchoolStudentRecord({
    db,
    partner,
    record: {
      external_student_id: 'S77',
      school_email: 'JANE@CC.EDU',
      gpa: 3.1,                       // school says 3.1, but user said 3.9 — keep user
      intended_major: 'Biology',      // user said 'Self-entered' — keep user
      enrollment_status: 'full_time', // empty on profile — accept school
      is_pell_eligible: true,
      home_state: 'TN',
    },
  })

  assert.equal(result.action, 'merged')
  assert.equal(result.profile_id, profileId)

  // primary_type was 'individual' so school's suggestion ('student') should land.
  const profile = db.tables.profiles.get(profileId)
  assert.equal(profile.primary_type, 'student')

  // Existing user-entered scalars must not be overwritten.
  const eduData = JSON.parse(db.tables.profile_sections.get(`${profileId}::education`).data)
  assert.equal(eduData.gpa, 3.9)
  assert.equal(eduData.intended_major, 'Self-entered')
  // But empty fields ARE filled.
  assert.equal(eduData.enrollment_status, 'full_time')
  assert.equal(eduData.pell_eligible, true)

  const basicData = JSON.parse(db.tables.profile_sections.get(`${profileId}::basic_information`).data)
  assert.equal(basicData.full_name, 'Jane Original')   // unchanged
  assert.equal(basicData.email, 'jane@cc.edu')          // unchanged

  const tags = JSON.parse(profile.tags)
  assert.ok(tags.includes('food'))                      // kept
  assert.ok(tags.includes('pell_eligible'))             // added
})

test('mergeSchoolStudentRecord throws on missing external_student_id', async () => {
  const db = makeMemoryDb()
  await assert.rejects(
    () => mergeSchoolStudentRecord({
      db,
      partner: { id: 'p3', slug: 'no-id', name: 'No ID' },
      record: { full_name: 'Nameless', email: 'x@y.z' },
    }),
    /external_student_id is required/i,
  )
})

test('mergeSchoolStudentRecord is idempotent on re-sync of the same record', async () => {
  const db = makeMemoryDb()
  const partner = { id: 'p4', slug: 'idem', name: 'Idem Univ' }
  const record = {
    external_student_id: 'IDEM1',
    school_email: 'idem@u.edu',
    full_name: 'Idem Student',
    student_level: 'Undergraduate',
    gpa: '3.5',
  }
  const first = await mergeSchoolStudentRecord({ db, partner, record })
  const second = await mergeSchoolStudentRecord({ db, partner, record })

  assert.equal(first.action, 'created')
  assert.equal(second.action, 'merged')
  assert.equal(first.profile_id, second.profile_id)
  assert.equal(first.link_id, second.link_id)
})
