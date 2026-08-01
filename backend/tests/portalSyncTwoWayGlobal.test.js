/**
 * GLOBAL two-way portal sync.
 *
 * OWNER RULE (2026-08-01): "Make sure the sync happens both ways… add to the
 * portal what funding sources have been accepted in GrantFlow and add to
 * GrantFlow what the portal shows. The two-way sync should be global for all
 * portals."
 *
 * TWO GAPS THIS CLOSES:
 *  1. `generic.write()` was a NO-OP returning "there is no structured data
 *     connector for this portal yet" — so every portal except MTSU was a
 *     ONE-WAY street: it pulled data in and never reported the household's own
 *     accepted awards back.
 *  2. The writer read only the `university_applications` section, so an award
 *     won anywhere else in the pipeline was invisible to the push. "Accepted"
 *     is a PIPELINE fact.
 *
 * Why it matters beyond tidiness: schools and funders REQUIRE students to
 * report outside scholarships, and an unreported award can mean a revised aid
 * package or a repayment demand later.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const Database = (await import('better-sqlite3')).default
const { collectAcceptedFundingSources } = await import('../services/hamilton/portalSync/acceptedFundingSources.js')
const { reportOutsideAwards } = await import('../services/hamilton/portalSync/outsideAwardReporter.js')

const PROFILE = 'p-two-way'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, funder TEXT,
      amount_awarded REAL, amount_requested REAL, status TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

function addGrant(db, { id, title, funder = null, awarded = null, requested = null, status = 'discovered' }) {
  db.prepare('INSERT INTO grants (id, profile_id, title, funder, amount_awarded, amount_requested, status) VALUES (?,?,?,?,?,?,?)')
    .run(id, PROFILE, title, funder, awarded, requested, status)
}

describe('collectAcceptedFundingSources — what GrantFlow pushes OUT', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('reports what was actually WON, and never what was merely applied for', async () => {
    addGrant(db, { id: 'g1', title: 'Rotary Club Scholarship', funder: 'Rotary', awarded: 2000, status: 'awarded' })
    addGrant(db, { id: 'g2', title: 'Elks Lodge Grant', funder: 'Elks', awarded: 1500, status: 'follow_up' }) // money recorded
    addGrant(db, { id: 'g3', title: 'Some Pending Scholarship', requested: 5000, status: 'submitted' })
    addGrant(db, { id: 'g4', title: 'Just Discovered Grant', status: 'discovered' })

    const out = await collectAcceptedFundingSources(db, { profileId: PROFILE })
    const names = out.sources.map((s) => s.name).sort()

    expect(names).toEqual(['Elks Lodge Grant', 'Rotary Club Scholarship'])
    // Telling a school you received aid you only APPLIED for would be a false
    // statement on a financial-aid record.
    expect(names).not.toContain('Some Pending Scholarship')
    expect(names).not.toContain('Just Discovered Grant')
    expect(out.sources.find((s) => s.name === 'Rotary Club Scholarship').amount).toBe(2000)
  })

  it('honors the household aid-type preference on the WRITE side too', async () => {
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'education', ?)")
      .run(PROFILE, JSON.stringify({ aid_types_accepted: ['grant', 'endowment', 'scholarship'] }))
    addGrant(db, { id: 'g1', title: 'Direct Subsidized Loan', awarded: 3500, status: 'awarded' })
    addGrant(db, { id: 'g2', title: 'Rotary Club Scholarship', awarded: 2000, status: 'awarded' })

    const out = await collectAcceptedFundingSources(db, { profileId: PROFILE })

    expect(out.sources.map((s) => s.name)).toEqual(['Rotary Club Scholarship'])
    // A declined kind is never reported to a third party on their behalf — and
    // never silently dropped either.
    expect(out.declinedByPreference).toEqual([{ name: 'Direct Subsidized Loan', aidType: 'loan' }])
  })

  it('also picks up awards imported from ANOTHER portal (the cross-portal case)', async () => {
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'university_applications', ?)")
      .run(PROFILE, JSON.stringify({
        applications: [{ imported_portal_awards: [{ title: 'MTSU True Blue Scholarship', amount: 4000, provider_name: 'MTSU' }] }],
      }))

    const out = await collectAcceptedFundingSources(db, { profileId: PROFILE })
    // A second school genuinely does need to know about the first school's award.
    expect(out.sources.map((s) => s.name)).toContain('MTSU True Blue Scholarship')
  })

  it('dedupes and never invents an amount', async () => {
    addGrant(db, { id: 'g1', title: 'Rotary Club Scholarship', awarded: 2000, status: 'awarded' })
    addGrant(db, { id: 'g2', title: 'rotary club scholarship', awarded: 2000, status: 'awarded' })
    addGrant(db, { id: 'g3', title: 'Unfunded Named Award', awarded: 0, status: 'awarded' })

    const out = await collectAcceptedFundingSources(db, { profileId: PROFILE })
    expect(out.sources.filter((s) => /rotary/i.test(s.name))).toHaveLength(1)
    expect(out.sources.find((s) => s.name === 'Unfunded Named Award').amount).toBe(null)
  })

  it('a missing grants table never silences the write side', async () => {
    const bare = new Database(':memory:')
    bare.exec('CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, PRIMARY KEY (profile_id, section_key));')
    const out = await collectAcceptedFundingSources(bare, { profileId: PROFILE })
    expect(out.sources).toEqual([])
  })
})

// ── The reporter: fills, never submits ───────────────────────────────────────

function makeFormPage({ hasForm = true, hasAmount = true } = {}) {
  const filled = []
  const clicked = []
  const input = (kind) => ({
    isVisible: async () => (kind === 'amount' ? hasAmount : hasForm),
    fill: async (v) => { filled.push({ kind, value: v }) },
  })
  return {
    filled,
    clicked,
    waitForLoadState: async () => {},
    getByLabel: (re) => ({ first: () => input(String(re).includes('amount') ? 'amount' : 'name') }),
    getByRole: (role, opts) => ({
      first: () => ({
        isVisible: async () => (role === 'link' ? false : true),
        click: async () => { clicked.push(String(opts?.name)) },
      }),
    }),
  }
}

describe('reportOutsideAwards — the GLOBAL write path', () => {
  it('fills each accepted source and NEVER submits by default', async () => {
    const page = makeFormPage()
    const res = await reportOutsideAwards(page, {
      sources: [{ name: 'Rotary Club Scholarship', amount: 2000 }, { name: 'Elks Lodge Grant', amount: 1500 }],
    })

    expect(res.written).toHaveLength(2)
    // The state is part of the record: "written" must never read as "sent".
    expect(res.written.every((w) => w.state === 'filled_not_submitted')).toBe(true)
    expect(res.submitted).toBe(false)
    // Submitting on a real financial-aid account is hard to reverse and can
    // trigger a revised aid package — it stays an authorized action.
    expect(page.clicked).toHaveLength(0)
    expect(page.filled.map((f) => f.value)).toContain('Rotary Club Scholarship')
    expect(page.filled.map((f) => f.value)).toContain('2000')
  })

  it('a portal with no reporting form SKIPS with an actionable reason, not a fake success', async () => {
    const page = makeFormPage({ hasForm: false })
    const res = await reportOutsideAwards(page, { sources: [{ name: 'Rotary Club Scholarship', amount: 2000 }] })

    expect(res.written).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/no outside-scholarship reporting form/i)
    // It must say what IS ready, so the owner can act by another route.
    expect(res.skipped[0].sources_ready).toBe(1)
  })

  it('nothing accepted yet → an honest skip, never an empty "success"', async () => {
    const res = await reportOutsideAwards(makeFormPage(), { sources: [] })
    expect(res.written).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/no accepted funding sources/i)
  })

  it('submits ONLY when the authorized path explicitly allows it', async () => {
    const page = makeFormPage()
    const res = await reportOutsideAwards(page, {
      sources: [{ name: 'Rotary Club Scholarship', amount: 2000 }],
      allowSubmit: true,
    })
    expect(res.submitted).toBe(true)
    expect(res.written[0].state).toBe('submitted')
    expect(page.clicked.length).toBeGreaterThan(0)
  })
})

describe('generic connector — every portal now has a real write', () => {
  it('generic.write() reports accepted sources instead of the old no-op note', async () => {
    const generic = (await import('../services/hamilton/portalSync/connectors/generic.js')).default
    const page = makeFormPage()
    page.goto = async () => {}

    const res = await generic.write(page, { portalHost: 'someportal.edu', log: () => {} }, {
      fundingSources: [{ name: 'Rotary Club Scholarship', amount: 2000 }],
    })

    expect(res.written).toHaveLength(1)
    // The old behavior: written:[] and "no structured data connector for this
    // portal yet" — a permanent one-way street for every non-MTSU portal.
    expect(JSON.stringify(res.skipped)).not.toMatch(/no structured data connector/i)
  })
})

describe('one-click submit — the owner/admin authorization path', () => {
  it('an ordinary write NEVER submits; only allowSubmit does', async () => {
    // This separation is the whole safety model: autonomous syncs stage values,
    // a human click sends them.
    const generic = (await import('../services/hamilton/portalSync/connectors/generic.js')).default
    const page = makeFormPage()
    page.goto = async () => {}

    const staged = await generic.write(page, { portalHost: 'x.edu', log: () => {} }, {
      fundingSources: [{ name: 'Rotary Club Scholarship', amount: 2000 }],
    })
    expect(staged.submitted).toBe(false)
    expect(staged.written[0].state).toBe('filled_not_submitted')
    expect(page.clicked).toHaveLength(0)

    const authorizedPage = makeFormPage()
    authorizedPage.goto = async () => {}
    const sent = await generic.write(authorizedPage, { portalHost: 'x.edu', log: () => {} }, {
      fundingSources: [{ name: 'Rotary Club Scholarship', amount: 2000 }],
      allowSubmit: true,
    })
    expect(sent.submitted).toBe(true)
    expect(authorizedPage.clicked.length).toBeGreaterThan(0)
  })

  it('an authorized submit with NO submit control reports NOT submitted — never a false send', async () => {
    // A portal that accepts outside awards by email has no submit button. The
    // owner must not be told their awards were reported when they were not.
    const page = makeFormPage()
    page.getByRole = () => ({ first: () => ({ isVisible: async () => false, click: async () => {} }) })

    const res = await reportOutsideAwards(page, {
      sources: [{ name: 'Rotary Club Scholarship', amount: 2000 }],
      allowSubmit: true,
    })

    expect(res.submitted).toBe(false)
    expect(res.written[0].state).toBe('filled_not_submitted')
    expect(res.skipped.some((s) => /no submit control/i.test(s.reason))).toBe(true)
  })
})
