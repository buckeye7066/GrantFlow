/**
 * generalApplicationCoverage — reflect a school's umbrella application onto
 * every portal link it governs (owner rule 2026-08-02: "If the school
 * determines eligibility based on the one general application, and that
 * general application is complete, then that should be reflected in those
 * related portals").
 *
 * The fixture is Demo Student's REAL prod pipeline (2026-08-02): six MTSU
 * scholarships governed by the General Scholarship Application, and six
 * MTSU-hosted rows that are NOT (admissions, housing, emergency fund, book
 * voucher, work-study, TELS) — the precision the rule lives or dies on.
 */
import { describe, it, expect, beforeEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const {
  applyGeneralApplicationCoverage, governedByGeneralApplication,
} = await import('../services/hamilton/portalSync/generalApplicationCoverage.js')
const { ensureApplicationTaskSchema, getApplicationTask, _resetSchemaCache } =
  await import('../services/hamilton/applicationTaskStore.js')
const { getPortalStatus } = await import('../services/hamilton/portalCompletionStore.js')

const P = 'p1'
const HOST = 'mtsu.scholarships.ngwebsolutions.com'
const EVIDENCE = 'Thank you for your submission of the Middle Tennessee State University Scholarship Application(s)'
const SUBMITTED = { status: 'submitted', evidence: EVIDENCE }

// (title, status, url) — verbatim from prod.
const GOVERNED = [
  ['MTSU True Blue Scholarship', 'pending_review', 'https://www.mtsu.edu/financial-aid/scholarships/true-blue.php'],
  ['MTSU Centennial Scholarship', 'pending_review', 'https://www.mtsu.edu/financial-aid/scholarships/centennial.php'],
  ['MTSU Academic Service Scholarship', 'pending_review', 'https://www.mtsu.edu/financial-aid/scholarships/academic-service.php'],
  ['MTSU University Honors College Scholarship', 'pending_review', 'https://www.mtsu.edu/honors/scholarships.php'],
  ['MTSU CBAS — Forensic Science Scholarships', 'pending_review', 'https://www.mtsu.edu/cbas/scholarships.php'],
  ['MTSU Foundation Need-Based Scholarships', 'pending_review', 'https://mtsu.academicworks.com/'],
]
const NOT_GOVERNED = [
  ['MTSU — Admissions Portal', 'pending_review', 'https://www.mtsu.edu/how-to-apply/'],
  ['MTSU — Off-Campus Housing', 'pending_review', 'https://offcampushousing.mtsu.edu/'],
  ['MTSU Student Emergency Fund', 'pending_review', 'https://www.mtsu.edu/dean-of-students/emergency-fund.php'],
  ['MTSU Book Voucher', 'pending_review', 'https://www.mtsu.edu/one-stop/'],
  ['Federal Work-Study at MTSU', 'portal', 'https://www.mtsu.edu/financial-aid'],
  ['TELS for Non-Traditional Students', 'submitted', 'https://www.mtsu.edu/financial-aid/non-traditional/'],
]

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT,
      application_url TEXT, url TEXT, portal_url TEXT,
      submitted_date TEXT, notes TEXT, updated_at DATETIME
    );
  `)
  return db
}

async function seed(db) {
  _resetSchemaCache() // the schema once-flag is per-process; each test gets a fresh :memory: db
  let i = 0
  for (const [title, status, url] of [...GOVERNED, ...NOT_GOVERNED]) {
    db.prepare('INSERT INTO grants (id, profile_id, title, status, application_url, url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`g${i++}`, P, title, status, url, url)
  }
  await ensureApplicationTaskSchema(db)
  // A Hamilton task per row, all waiting_for_review (the live shape). Direct
  // inserts: ensureApplicationTask generates its own id and cannot set
  // portal_url/status, and this fixture needs stable ids to assert on.
  i = 0
  for (const [, , url] of [...GOVERNED, ...NOT_GOVERNED]) {
    db.prepare(`INSERT INTO application_tasks (id, profile_id, grant_id, status, portal_url)
      VALUES (?, ?, ?, 'waiting_for_review', ?)`).run(`t${i}`, P, `g${i}`, url)
    i += 1
  }
}

describe('governedByGeneralApplication — URL-structural precision', () => {
  it('governs the tenant portal, the legacy AcademicWorks portal, and mtsu.edu scholarship paths', () => {
    expect(governedByGeneralApplication('mtsu', `https://${HOST}/Scholarships/Search`)).toBe(true)
    expect(governedByGeneralApplication('mtsu', 'https://mtsu.academicworks.com/')).toBe(true)
    for (const [, , url] of GOVERNED) expect(governedByGeneralApplication('mtsu', url)).toBe(true)
  })
  it('NEVER governs admissions/housing/emergency/one-stop/work-study on the same host', () => {
    for (const [, , url] of NOT_GOVERNED) expect(governedByGeneralApplication('mtsu', url)).toBe(false)
  })
  it('an unknown tenant or junk URL governs nothing', () => {
    expect(governedByGeneralApplication('unknowncollege', 'https://www.mtsu.edu/financial-aid/scholarships/x.php')).toBe(false)
    expect(governedByGeneralApplication('mtsu', 'not a url')).toBe(false)
    expect(governedByGeneralApplication('mtsu', null)).toBe(false)
  })
})

describe('applyGeneralApplicationCoverage', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await seed(db)
  })

  it('a VERIFIED submission advances exactly the six governed grants and completes their tasks', async () => {
    const out = await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu',
      generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    expect(out.applied).toBe(true)
    expect(out.grants_advanced).toHaveLength(GOVERNED.length)

    for (let i = 0; i < GOVERNED.length; i++) {
      const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(`g${i}`)
      expect(g.status).toBe('submitted')
      expect(g.submitted_date).toBeTruthy() // enforceImportedStatusHonesty demotes NULL-dated submissions
      expect(g.notes).toMatch(/General Scholarship Application/)
      expect(g.notes).toMatch(/run-1/)
      const t = await getApplicationTask(db, `t${i}`)
      expect(t.status).toBe('completed')
      expect(t.last_agent_message).toMatch(/covered by the General Scholarship Application/i)
    }
  })

  it('leaves every NON-governed row untouched — including the already-submitted TELS row', async () => {
    await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu',
      generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    for (let i = GOVERNED.length; i < GOVERNED.length + NOT_GOVERNED.length; i++) {
      const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(`g${i}`)
      expect(g.status).toBe(NOT_GOVERNED[i - GOVERNED.length][1])
      expect(g.notes).toBeNull()
      const t = await getApplicationTask(db, `t${i}`)
      expect(t.status).toBe('waiting_for_review')
    }
  })

  it('marks the portal itself COMPLETE with the evidence', async () => {
    await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu',
      generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    const status = await getPortalStatus(db, P, HOST)
    expect(status?.status).toBe('complete')
  })

  it('is a HARD NO-OP without a verified submission (no_open_applications, null, missing evidence)', async () => {
    for (const ga of [null, { status: 'no_open_applications', evidence: 'x' }, { status: 'submitted' }]) {
      const out = await applyGeneralApplicationCoverage(db, {
        profileId: P, portalHost: HOST, tenant: 'mtsu', generalApplication: ga,
      })
      expect(out.applied).toBe(false)
    }
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get('g0')
    expect(g.status).toBe('pending_review')
  })

  it('is idempotent: a second verified sync advances nothing new and never re-stamps', async () => {
    await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu', generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    const firstDate = db.prepare('SELECT submitted_date FROM grants WHERE id = ?').get('g0').submitted_date
    const out2 = await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu', generalApplication: SUBMITTED, syncRunId: 'run-2',
    })
    expect(out2.grants_advanced).toHaveLength(0)
    expect(out2.tasks_completed).toHaveLength(0)
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get('g0')
    expect(g.submitted_date).toBe(firstDate)
    expect(g.notes).not.toMatch(/run-2/)
  })

  it('never demotes: an awarded governed grant stays awarded', async () => {
    db.prepare("UPDATE grants SET status = 'awarded' WHERE id = 'g0'").run()
    await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: HOST, tenant: 'mtsu', generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    expect(db.prepare('SELECT status FROM grants WHERE id = ?').get('g0').status).toBe('awarded')
  })

  it('covers the Cleveland State tenant with the same rule', async () => {
    db.prepare('INSERT INTO grants (id, profile_id, title, status, application_url, url) VALUES (?, ?, ?, ?, ?, ?)')
      .run('gc', P, 'Adrienne Emond/Delta Kappa Gamma Scholarship', 'portal',
        'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search',
        'https://clevelandstatecc.scholarships.ngwebsolutions.com/Scholarships/Search')
    const out = await applyGeneralApplicationCoverage(db, {
      profileId: P, portalHost: 'clevelandstatecc.scholarships.ngwebsolutions.com', tenant: 'clevelandstatecc',
      generalApplication: SUBMITTED, syncRunId: 'run-1',
    })
    expect(out.grants_advanced.map((g) => g.id)).toContain('gc')
    // The MTSU-governed rows are NOT touched by the CSCC tenant's application.
    expect(db.prepare('SELECT status FROM grants WHERE id = ?').get('g0').status).toBe('pending_review')
  })
})
