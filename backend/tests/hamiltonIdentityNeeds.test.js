/**
 * Owner order 2026-09-05: Hamilton asks, at login, for the identity values his
 * pipeline needs and stores them in the vault. Live case: a student committed
 * to MTSU with MTSU scholarships (PipelineMT login), a TSAC award (FSA ID) and
 * real forms (SSN) — and a vault holding only her date of birth.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { resolveIdentityNeeds, emitIdentityNeedsReminder } from '../services/hamilton/hamiltonIdentityNeeds.js'
import { HAMILTON_NOTIFICATION_TYPES, emitHamiltonNotificationToProfileAndAdmins } from '../services/hamilton/hamiltonNotifications.js'
import { IDENTITY_REQUEST_NOTIFICATION_TYPE, emitIdentityRequest } from '../services/hamilton/hamiltonIdentityRequest.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT, primary_type TEXT);
    CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT, application_url TEXT, portal_url TEXT, url TEXT, funding_opportunity_id TEXT, funder TEXT, updated_at TEXT);
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, application_url TEXT, apply_url TEXT, source_url TEXT, application_mode TEXT, opportunity_kind TEXT);
    CREATE TABLE notifications (id TEXT, type TEXT, data TEXT, created_at TEXT);
  `)
  db.prepare("INSERT INTO profiles VALUES ('p-a','u-a','Student A','student')").run()
  const opp = db.prepare('INSERT INTO funding_opportunities (id, title, sponsor, application_url) VALUES (?, ?, ?, ?)')
  const grant = db.prepare("INSERT INTO grants (id, profile_id, title, status, application_url, funding_opportunity_id, updated_at) VALUES (?, 'p-a', ?, ?, ?, ?, '2026-09-05')")
  opp.run('o-dream', 'DREAM Scholarship', 'Middle Tennessee State University', 'https://mtsu.edu/scholarships')
  grant.run('g-dream', 'DREAM Scholarship', 'discovered', 'https://mtsu.edu/scholarships', 'o-dream')
  opp.run('o-gams', 'Tennessee General Assembly Merit Scholarship', 'Tennessee Student Assistance Corporation', 'https://www.tn.gov/collegepays/financial-aid/general-assembly-merit-scholarship.html')
  grant.run('g-gams', 'Tennessee General Assembly Merit Scholarship', 'discovered', 'https://www.tn.gov/collegepays/financial-aid/general-assembly-merit-scholarship.html', 'o-gams')
  opp.run('o-afte', 'AFTE Forensic Science Scholarship', 'Association of Firearm and Tool Mark Examiners', 'https://www.afte.org/scholarship')
  grant.run('g-afte', 'AFTE Forensic Science Scholarship', 'discovered', 'https://www.afte.org/scholarship', 'o-afte')
  opp.run('o-done', 'Federal Pell Grant', 'Federal Student Aid', 'https://studentaid.gov/understand-aid/types/grants/pell')
  grant.run('g-done', 'Federal Pell Grant', 'submitted', 'https://studentaid.gov/understand-aid/types/grants/pell', 'o-done')
  return db
}

const committedProfile = async () => ({
  profile: { id: 'p-a', primary_type: 'student', display_name: 'Student A' },
  sections: {
    education: { current_institution: 'Middle Tennessee State University', intended_major: 'Forensic Science' },
    university_applications: { applications: [{ name: 'Middle Tennessee State University', status: 'committed' }] },
  },
})

describe('resolveIdentityNeeds', () => {
  it('derives PipelineMT (SSO), FSA ID and SSN from the pipeline and subtracts what the vault holds', async () => {
    const db = makeDb()
    const result = await resolveIdentityNeeds(db, {
      profileId: 'p-a',
      deps: { loadProfile: committedProfile, listIdentitySecrets: async () => [{ kind: 'date_of_birth' }] },
    })
    const kinds = result.needs.map((n) => n.kind)
    expect(kinds).toEqual(['sso_username', 'sso_password', 'fsa_id_username', 'fsa_id_password', 'ssn'])
    const sso = result.needs.find((n) => n.kind === 'sso_username')
    expect(sso.reasons[0]).toMatch(/PipelineMT/)
    expect(sso.sources).toContain('DREAM Scholarship')
    expect(sso.add_link).toMatch(/addIdentity=sso_username/)
    const fsa = result.needs.find((n) => n.kind === 'fsa_id_username')
    expect(fsa.sources).toContain('Tennessee General Assembly Merit Scholarship')
    expect(result.on_file_kinds).toEqual(['date_of_birth'])
    expect(result.sources_considered).toBe(3) // the submitted Pell row is protected and not counted
    expect(result.needs_attention).toBe(true)
  })

  it('asks for nothing the vault already holds, and nothing when the pipeline is empty', async () => {
    const db = makeDb()
    const full = await resolveIdentityNeeds(db, {
      profileId: 'p-a',
      deps: {
        loadProfile: committedProfile,
        listIdentitySecrets: async () => ['sso_username', 'sso_password', 'fsa_id_username', 'fsa_id_password', 'ssn', 'date_of_birth'].map((kind) => ({ kind })),
      },
    })
    expect(full.needs).toHaveLength(0)
    expect(full.needs_attention).toBe(false)
    db.prepare('DELETE FROM grants').run()
    const empty = await resolveIdentityNeeds(db, { profileId: 'p-a', deps: { loadProfile: committedProfile, listIdentitySecrets: async () => [] } })
    expect(empty.needs).toHaveLength(0)
    expect(empty.sources_considered).toBe(0)
  })

  it('a student with no institution is not asked for a university SSO', async () => {
    const db = makeDb()
    const result = await resolveIdentityNeeds(db, {
      profileId: 'p-a',
      deps: { loadProfile: async () => ({ profile: { id: 'p-a', primary_type: 'student' }, sections: {} }), listIdentitySecrets: async () => [] },
    })
    const kinds = result.needs.map((n) => n.kind)
    expect(kinds).not.toContain('sso_username')
    expect(kinds).toContain('fsa_id_username')
    expect(kinds).toContain('ssn')
  })
})

describe('emitIdentityNeedsReminder', () => {
  it('posts one notification naming the kinds with the vault deep link, and not again while the set is unchanged', async () => {
    const db = makeDb()
    const emitted = []
    const deps = {
      loadProfile: committedProfile,
      listIdentitySecrets: async () => [{ kind: 'date_of_birth' }],
      emit: async (_db, payload) => { emitted.push(payload) },
    }
    let notified = false
    const first = await emitIdentityNeedsReminder(db, { profileId: 'p-a', deps: { ...deps, recentlyNotified: async () => notified } })
    expect(first).toBe(1)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].type).toBe('hamilton_identity_needed')
    expect(emitted[0].data.identity_fingerprint).toBe('sso_username|sso_password|fsa_id_username|fsa_id_password|ssn')
    expect(emitted[0].data.link ?? emitted[0].data.add_link ?? JSON.stringify(emitted[0].data)).toMatch(/identity-vault/)
    expect(emitted[0].message).toMatch(/PipelineMT/)
    notified = true
    const second = await emitIdentityNeedsReminder(db, { profileId: 'p-a', deps: { ...deps, recentlyNotified: async () => notified } })
    expect(second).toBe(0)
    expect(emitted).toHaveLength(1)
  })

  it('a vault that holds everything emits nothing', async () => {
    const db = makeDb()
    const emitted = []
    const count = await emitIdentityNeedsReminder(db, {
      profileId: 'p-a',
      deps: {
        loadProfile: committedProfile,
        listIdentitySecrets: async () => ['sso_username', 'sso_password', 'fsa_id_username', 'fsa_id_password', 'ssn', 'date_of_birth'].map((kind) => ({ kind })),
        emit: async (_db, payload) => { emitted.push(payload) },
      },
    })
    expect(count).toBe(0)
    expect(emitted).toHaveLength(0)
  })
})

describe('the identity ask actually reaches the notification store (registry guard)', () => {
  it('hamilton_identity_needed is a registered Hamilton notification type', () => {
    expect(HAMILTON_NOTIFICATION_TYPES).toContain(IDENTITY_REQUEST_NOTIFICATION_TYPE)
  })

  it('a REAL emit (no injected emitter) lands a row instead of being refused as an invalid type', async () => {
    // Found 2026-09-05: the emitter had existed since 2026-08-21 but the type was
    // never registered, so every ask threw "invalid hamilton notification type"
    // into a swallowing catch. Drive the real emitter end to end.
    const db = makeDb()
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT)')
    db.exec("DROP TABLE notifications")
    const emitted = await emitIdentityRequest(db, { profileId: 'p-a', profileUserId: 'u-a', kinds: ['sso_username'], host: 'mtsu.scholarships.ngwebsolutions.com', fundingTitle: 'MTSU Guaranteed Scholarship' })
    expect(emitted).toBeTruthy()
    const rows = db.prepare('SELECT type, message FROM notifications').all()
    expect(rows.some((r) => r.type === IDENTITY_REQUEST_NOTIFICATION_TYPE)).toBe(true)
    expect(rows[0].message).toMatch(/University SSO username/)
    const count = await emitIdentityNeedsReminder(db, {
      profileId: 'p-a',
      deps: { loadProfile: committedProfile, listIdentitySecrets: async () => [{ kind: 'date_of_birth' }], emit: emitHamiltonNotificationToProfileAndAdmins },
    })
    expect(count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE type = ?').get(IDENTITY_REQUEST_NOTIFICATION_TYPE).n).toBeGreaterThanOrEqual(2)
  })
})
