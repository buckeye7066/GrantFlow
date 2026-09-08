/**
 * One question, one field (owner order 2026-09-08): the duplicate profile
 * questions are hidden, and the hidden legacy keys are DERIVED from the
 * canonical answers so every reader of a legacy key keeps seeing the truth.
 *
 * Fixture names are synthetic (the privacy tripwire bans real profile names).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  PROFILE_FIELD_MIRROR_RULES,
  deriveProfileFieldMirrors,
  mirrorTargets,
  ageGroupForAge,
} from '../../shared/profileFieldMirrors.js'
import { applyProfileFieldMirrors, loadProfileSections } from '../services/profileFieldMirrors.js'
import { enforceProfileFieldMirrorBackfill } from '../startup/enforceInvariants.js'
import { SECTION_METADATA } from '../../src/config/sectionMetadata.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      status TEXT DEFAULT 'active',
      deleted_at TEXT,
      state TEXT,
      zip_code TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (profile_id, section_key)
    );
  `)
  return raw
}
const section = (db, profileId, key, data) =>
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)').run(profileId, key, JSON.stringify(data))
const read = (db, profileId, key) => {
  const row = db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profileId, key)
  return row ? JSON.parse(row.data) : undefined
}

describe('PROFILE_FIELD_MIRROR_RULES — the contract with SECTION_METADATA', () => {
  const field = (sec, name) => (SECTION_METADATA[sec]?.fields || []).find((f) => f.name === name)

  it('every mirror TARGET is a deprecated (hidden) metadata field', () => {
    const notDeprecated = mirrorTargets().filter((id) => {
      const [sec, name] = id.split('.')
      return !field(sec, name)?.deprecated
    })
    expect(notDeprecated).toEqual([])
  })

  it('every mirror SOURCE is a live (non-deprecated) metadata field the user can answer', () => {
    const bad = []
    for (const rule of PROFILE_FIELD_MIRROR_RULES) {
      for (const [sec, name] of rule.sources) {
        const f = field(sec, name)
        if (!f) bad.push(`${sec}.${name}:missing`)
        else if (f.deprecated) bad.push(`${sec}.${name}:deprecated`)
      }
    }
    expect(bad).toEqual([])
  })

  it('a reverse rule always names a live canonical field to seed', () => {
    const bad = []
    for (const rule of PROFILE_FIELD_MIRROR_RULES) {
      if (typeof rule.reverse !== 'function') continue
      const [sec, name] = rule.reverseTarget || rule.sources[0]
      const f = field(sec, name)
      if (!f || f.deprecated) bad.push(`${sec}.${name}`)
    }
    expect(bad).toEqual([])
  })
})

describe('deriveProfileFieldMirrors — forward (canonical → hidden legacy)', () => {
  it('derives Demographics > Veteran status from the Military service section', () => {
    const { patches } = deriveProfileFieldMirrors({ military_service: { veteran: true, disabled_veteran: false } })
    expect(patches.demographics.veteran_status).toBe('veteran')
    const disabled = deriveProfileFieldMirrors({ military_service: { veteran: true, disabled_veteran: true } })
    expect(disabled.patches.demographics.veteran_status).toBe('disabled veteran')
    // An explicit NO clears a stale legacy claim.
    const no = deriveProfileFieldMirrors({ military_service: { veteran: false }, demographics: { veteran_status: 'veteran' } })
    expect(no.patches.demographics.veteran_status).toBe('')
    // Silence derives nothing — the legacy answer is left alone.
    const silent = deriveProfileFieldMirrors({ military_service: {}, demographics: { veteran_status: 'veteran' } })
    expect(silent.patches.demographics).toBeUndefined()
  })

  it('derives the immigration trio from the one enum the form still asks', () => {
    const { patches } = deriveProfileFieldMirrors({ demographics: { immigration_status: 'us_citizen' } })
    expect(patches.demographics).toMatchObject({ immigrant_status: 'us_citizen', us_citizen: true, citizenship: 'US citizen' })
    const refugee = deriveProfileFieldMirrors({ demographics: { immigration_status: 'refugee' } })
    expect(refugee.patches.demographics).toMatchObject({ immigrant_status: 'refugee', us_citizen: false, citizenship: 'refugee' })
    const unknown = deriveProfileFieldMirrors({ demographics: { immigration_status: 'unknown' } })
    expect(unknown.patches.demographics?.us_citizen).toBeUndefined()
  })

  it('derives the credit toggle (700+) from the numeric credit score', () => {
    expect(deriveProfileFieldMirrors({ financial_information: { credit_score: 720 } }).patches.demographics.good_credit_score).toBe(true)
    expect(deriveProfileFieldMirrors({ financial_information: { credit_score: '650' } }).patches.demographics.good_credit_score).toBe(false)
    expect(deriveProfileFieldMirrors({ financial_information: { credit_score: '' } }).patches.demographics).toBeUndefined()
  })

  it('derives employment / household / housing / benefit duplicates', () => {
    const { patches } = deriveProfileFieldMirrors({
      financial_information: { employment_status: 'unemployed_seeking', household_size: 4 },
      housing: { status: 'homeless' },
      government_assistance: { medicaid_recipient_self: true, snap_recipient_self: false },
      family_life: { caregiver: true },
      basic_information: { gender: 'female', date_of_birth: '1950-06-15' },
    })
    expect(patches.financial_information.unemployed).toBe(true)
    expect(patches.employment.current_status).toBe('unemployed_seeking')
    expect(patches.family_life).toMatchObject({ household_size: 4, homeless: true, family_caregiver: true })
    expect(patches.family.household_size).toBe(4)
    // The guard stores `<base>_recipient_self`; the legacy spelling is derived
    // from it so its (more numerous) readers keep seeing the answer.
    expect(patches.government_assistance).toMatchObject({ medicaid_enrolled: true, snap_recipient: false })
    expect(patches.demographics.gender).toBe('female')
    expect(patches.demographics.age_group).toBe('senior')
    expect(Number(patches.basic_information.age)).toBeGreaterThan(70)
  })

  it('derives disability status from the health section (types + flags)', () => {
    const { patches } = deriveProfileFieldMirrors({ health_medical: { disability_type: ['mobility'], wheelchair_user: true } })
    expect(patches.demographics.disability_status).toBe('mobility, wheelchair user')
  })

  it('is idempotent: a fully derived profile produces no patch', () => {
    const sections = { military_service: { veteran: true }, demographics: {} }
    const first = deriveProfileFieldMirrors(sections)
    sections.demographics = { ...sections.demographics, ...first.patches.demographics }
    const second = deriveProfileFieldMirrors(sections)
    expect(second.patches).toEqual({})
  })

  it('ageGroupForAge buckets', () => {
    expect(ageGroupForAge(12)).toBe('youth')
    expect(ageGroupForAge(20)).toBe('young adult')
    expect(ageGroupForAge(40)).toBe('adult')
    expect(ageGroupForAge(70)).toBe('senior')
  })
})

describe('deriveProfileFieldMirrors — reverse seeding (legacy → canonical, backfill only)', () => {
  it('seeds the canonical field from a legacy-only answer, then derives forward', () => {
    const sections = {
      demographics: { veteran_status: 'Army veteran', immigrant_status: 'permanent_resident', religious_denomination: 'Baptist', heritage: 'Irish' },
      financial_information: { unemployed: true },
      government_assistance: { ssi_recipient_household: true },
      family_life: { homeless: true },
    }
    const { patches } = deriveProfileFieldMirrors(sections, { seedCanonical: true })
    expect(patches.military_service.veteran).toBe(true)
    expect(patches.demographics).toMatchObject({
      immigration_status: 'permanent_resident',
      religious_affiliation: 'Baptist',
      ethnicity: 'Irish',
      veteran_status: 'veteran',
    })
    expect(patches.financial_information.employment_status).toBe('unemployed_seeking')
    // A HOUSEHOLD-only legacy answer seeds the canonical `_self` key (the legacy
    // value lives in neither `target` nor the plain spelling, which is exactly
    // the seed the old `target`-only precondition skipped), and the legacy
    // spelling is then derived forward from it.
    expect(patches.government_assistance.ssi_recipient_self).toBe(true)
    expect(patches.government_assistance.ssi_recipient).toBe(true)
    expect(patches.housing.status).toBe('homeless')
  })

  it('never overwrites a canonical answer that already exists', () => {
    const { patches } = deriveProfileFieldMirrors(
      { demographics: { religious_affiliation: 'Catholic', religious_denomination: 'Baptist' } },
      { seedCanonical: true },
    )
    expect(patches.demographics?.religious_affiliation).toBeUndefined()
    expect(patches.demographics.religious_denomination).toBe('Catholic')
  })

  it('does not seed without seedCanonical (the per-save path never reverses)', () => {
    const { patches } = deriveProfileFieldMirrors({ demographics: { veteran_status: 'veteran' } })
    expect(patches.military_service).toBeUndefined()
  })
})

describe('applyProfileFieldMirrors (persisted)', () => {
  it('writes only the sections a rule changed, merging into the stored row', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type) VALUES ('p1', 'Synthetic One', 'senior')").run()
    section(db, 'p1', 'military_service', { veteran: true, notes: 'kept' })
    section(db, 'p1', 'demographics', { ethnicity: 'Greek', notes: 'demo notes' })
    const r = await applyProfileFieldMirrors(db, 'p1', { updatedBy: 'test' })
    expect(r.changed.map((c) => c.section).sort()).toEqual(['demographics'])
    expect(read(db, 'p1', 'demographics')).toMatchObject({ ethnicity: 'Greek', heritage: 'Greek', veteran_status: 'veteran', notes: 'demo notes' })
    expect(read(db, 'p1', 'military_service')).toEqual({ veteran: true, notes: 'kept' })
    const again = await applyProfileFieldMirrors(db, 'p1', { updatedBy: 'test' })
    expect(again.changed).toEqual([])
  })

  it('loadProfileSections tolerates a malformed row', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p2', 'demographics', 'not json')").run()
    expect(await loadProfileSections(db, 'p2')).toEqual({ demographics: {} })
  })
})

describe('enforceProfileFieldMirrorBackfill (boot net)', () => {
  const saved = {}
  beforeEach(() => {
    saved.enforce = process.env.ENFORCE_PROFILE_FIELD_MIRRORS
    saved.limit = process.env.PROFILE_FIELD_MIRROR_LIMIT
    delete process.env.ENFORCE_PROFILE_FIELD_MIRRORS
    delete process.env.PROFILE_FIELD_MIRROR_LIMIT
  })
  afterEach(() => {
    if (saved.enforce === undefined) delete process.env.ENFORCE_PROFILE_FIELD_MIRRORS
    else process.env.ENFORCE_PROFILE_FIELD_MIRRORS = saved.enforce
    if (saved.limit === undefined) delete process.env.PROFILE_FIELD_MIRROR_LIMIT
    else process.env.PROFILE_FIELD_MIRROR_LIMIT = saved.limit
  })

  it('seeds canonical fields from legacy-only answers and derives the rest, for every live profile', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type) VALUES ('p1', 'Synthetic One', 'senior')").run()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES ('p-del', 'Gone', 'senior', 'deleted')").run()
    section(db, 'p1', 'demographics', { veteran_status: 'Navy veteran', us_citizen: true })
    section(db, 'p-del', 'demographics', { veteran_status: 'veteran' })
    const res = await enforceProfileFieldMirrorBackfill(db)
    expect(res.ok).toBe(true)
    expect(res.scanned).toBe(1)
    expect(res.repaired).toBe(1)
    expect(res.seeded).toBeGreaterThan(0)
    expect(read(db, 'p1', 'military_service')).toMatchObject({ veteran: true })
    expect(read(db, 'p1', 'demographics')).toMatchObject({ immigration_status: 'us_citizen', immigrant_status: 'us_citizen', citizenship: 'US citizen' })
    expect(read(db, 'p-del', 'military_service')).toBeUndefined()
    // idempotent
    const second = await enforceProfileFieldMirrorBackfill(db)
    expect(second.repaired).toBe(0)
  })

  it('count-only mode reports and writes nothing', async () => {
    process.env.ENFORCE_PROFILE_FIELD_MIRRORS = '0'
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type) VALUES ('p1', 'Synthetic One', 'senior')").run()
    section(db, 'p1', 'military_service', { veteran: true })
    const res = await enforceProfileFieldMirrorBackfill(db)
    expect(res.countOnly).toBe(true)
    expect(res.wouldRepair).toBe(1)
    expect(read(db, 'p1', 'demographics')).toBeUndefined()
  })

  it('degrades to skipped on a schema without the tables', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, status TEXT)')
    const res = await enforceProfileFieldMirrorBackfill(raw)
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe('profiles_or_sections_missing')
  })
})
