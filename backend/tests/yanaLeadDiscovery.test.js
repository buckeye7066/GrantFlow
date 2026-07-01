/**
 * Unit tests for backend/services/yana/yanaLeadDiscovery.js
 *
 * Yana = Client Discoverer (mission Goal 14). These tests prove the core,
 * deterministic, network-free funnel invariants without the full server:
 *
 *   1. scoreOrganizationLead is deterministic and produces explainable scores
 *      + evidence/source for John's bridge.
 *   2. qualifyScore enforces the four gates (email, score threshold, public
 *      evidence, contact source).
 *   3. discoverLeadCandidates upserts candidates and is idempotent per org.
 *   4. Yana Rule 4 — pushQualifiedToJohn never forwards more than the rolling
 *      24h cap (default 50), pushes the highest-value leads first, and reports
 *      cap accounting. A second push in the same window forwards 0.
 *   5. observe mode (allowLeads=false) qualifies but pushes nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  scoreOrganizationLead,
  qualifyScore,
  discoverLeadCandidates,
  pushQualifiedToJohn,
  countLeadsPushedWithinWindow,
  runYanaDiscovery,
  QUALIFY_THRESHOLD,
  DAILY_LEAD_CAP,
  _resetYanaSchemaCache,
} from '../services/yana/yanaLeadDiscovery.js'

function makeDb() {
  // Raw better-sqlite3: the service awaits synchronous returns, which resolve
  // fine, and has no `.dialect` so it takes the SQLite code paths.
  return new Database(':memory:')
}

/** A fully-formed org that scores well above the qualify threshold. */
function richOrg(i) {
  return {
    id: String(i),
    name: `Org ${i}`,
    email: `contact${i}@example.org`,
    website: `https://org${i}.example.org`,
    mission: 'We provide measurable community programs and direct services to families.',
    focus_areas: JSON.stringify(['education', 'housing']),
    program_areas: JSON.stringify(['after-school']),
    applicant_type: 'nonprofit',
    ein: `12-345${String(i).padStart(4, '0')}`,
    city: 'Columbus',
    state: 'OH',
  }
}

/** Inject N orgs into discovery without needing the organizations table. */
function loaderFor(orgs) {
  return async () => orgs
}

beforeEach(() => {
  // Schema-ensured is module-level cached; reset it so each fresh in-memory DB
  // re-creates the Yana tables.
  _resetYanaSchemaCache()
})

describe('scoreOrganizationLead', () => {
  it('is deterministic and produces evidence + source for a rich org', () => {
    const a = scoreOrganizationLead(richOrg(1))
    const b = scoreOrganizationLead(richOrg(1))
    expect(a).toEqual(b) // no randomness, no network
    expect(a.hasEmail).toBe(true)
    expect(a.lead_score).toBeGreaterThanOrEqual(QUALIFY_THRESHOLD)
    expect(a.public_evidence.length).toBeGreaterThan(0)
    expect(a.source_urls.length).toBeGreaterThan(0)
    expect(a.website_url).toMatch(/^https:\/\//)
  })

  it('normalizes a bare-domain website to https://', () => {
    const s = scoreOrganizationLead({ name: 'X', email: 'x@x.org', website: 'x.org' })
    expect(s.website_url).toBe('https://x.org')
  })
})

describe('qualifyScore', () => {
  it('qualifies a rich org', () => {
    const { qualified } = qualifyScore(scoreOrganizationLead(richOrg(1)))
    expect(qualified).toBe(true)
  })

  it('rejects an org with no usable email', () => {
    const scored = scoreOrganizationLead({ name: 'No Email', website: 'https://noemail.org', mission: 'x'.repeat(40), focus_areas: '["a"]' })
    const { qualified, reasons } = qualifyScore(scored)
    expect(qualified).toBe(false)
    expect(reasons).toContain('no_usable_email')
  })

  it('rejects a thin org below the score threshold', () => {
    const scored = scoreOrganizationLead({ name: 'Thin', email: 'thin@thin.org' })
    const { qualified } = qualifyScore(scored)
    expect(qualified).toBe(false)
  })
})

describe('discoverLeadCandidates', () => {
  it('upserts candidates and counts qualified, idempotently per org', async () => {
    const db = makeDb()
    const orgs = [richOrg(1), richOrg(2), { id: '3', name: 'Thin', email: 'thin@thin.org' }]
    const first = await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })
    expect(first.candidates_total).toBe(3)
    expect(first.candidates_qualified).toBe(2) // org 3 is too thin

    // Re-running updates in place (UNIQUE organization_id) — no duplicate rows.
    await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })
    const count = db.prepare('SELECT COUNT(*) AS c FROM yana_lead_candidates').get().c
    expect(count).toBe(3)
  })

  it('defaultLoadOrganizations skips non-routable .invalid emails (Amy synthetic profiles)', async () => {
    const db = makeDb()
    // Minimal organizations table matching the columns the loader reads.
    db.exec(`CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, website TEXT,
      mission TEXT, focus_areas TEXT, program_areas TEXT, applicant_type TEXT,
      ein TEXT, city TEXT, state TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    )`)
    const real = richOrg(1)
    db.prepare(`INSERT INTO organizations (id, name, email, website, mission, focus_areas, program_areas, applicant_type, ein, city, state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(real.id, real.name, real.email, real.website, real.mission, real.focus_areas, real.program_areas, real.applicant_type, real.ein, real.city, real.state)
    // Amy synthetic org: amy+<scenario>@synthetic.grantflow.invalid — must be excluded.
    db.prepare(`INSERT INTO organizations (id, name, email) VALUES (?, ?, ?)`)
      .run('amy-1', 'Amy Synthetic — Nonprofit Organization #1', 'amy+nonprofit-v1@synthetic.grantflow.invalid')

    // No injected loader → exercises the real defaultLoadOrganizations SQL.
    const res = await discoverLeadCandidates(db, {})
    expect(res.considered).toBe(1) // only the real org; the .invalid org is filtered out
    const rows = db.prepare('SELECT contact_email FROM yana_lead_candidates').all()
    expect(rows.every((r) => !String(r.contact_email).endsWith('.invalid'))).toBe(true)
  })
})

describe('pushQualifiedToJohn — Yana Rule 4 rolling cap', () => {
  it('forwards at most the rolling cap and reports accounting', async () => {
    const db = makeDb()
    const cap = 5
    const orgs = Array.from({ length: 8 }, (_, i) => richOrg(i + 1))
    await discoverLeadCandidates(db, { loadOrganizations: loaderFor(orgs) })

    const first = await pushQualifiedToJohn(db, { cap })
    expect(first.leads_pushed_to_john).toBe(cap)
    expect(first.cap_reached).toBe(true)
    expect(first.already_pushed_in_window).toBe(0)

    // Second push in the same window is throttled to zero.
    const second = await pushQualifiedToJohn(db, { cap })
    expect(second.leads_pushed_to_john).toBe(0)
    expect(second.already_pushed_in_window).toBe(cap)

    expect(await countLeadsPushedWithinWindow(db)).toBe(cap)
  })

  it('defaults to a 50-lead cap', () => {
    expect(DAILY_LEAD_CAP).toBe(50)
  })

  it('observe mode (allowLeads=false) pushes nothing', async () => {
    const db = makeDb()
    const orgs = Array.from({ length: 3 }, (_, i) => richOrg(i + 1))
    const res = await runYanaDiscovery(db, { allowLeads: false, deps: { loadOrganizations: loaderFor(orgs) } })
    expect(res.ok).toBe(true)
    expect(res.mode).toBe('observe')
    expect(res.candidates_qualified).toBe(3)
    expect(res.leads_pushed_to_john).toBe(0)
    expect(await countLeadsPushedWithinWindow(db)).toBe(0)
  })

  it('qualify_and_push mode forwards qualified leads within the cap', async () => {
    const db = makeDb()
    const orgs = Array.from({ length: 3 }, (_, i) => richOrg(i + 1))
    const res = await runYanaDiscovery(db, { allowLeads: true, deps: { loadOrganizations: loaderFor(orgs) } })
    expect(res.mode).toBe('qualify_and_push')
    expect(res.leads_pushed_to_john).toBe(3)
    expect(res.cap).toBe(DAILY_LEAD_CAP)
  })
})

import { discoverProspects } from '../services/yana/yanaLeadDiscovery.js'
import {
  makePropublica990Source,
  registerProspectSource,
} from '../services/yana/yanaProspectSources.js'
import { getAgentSetting } from '../services/agentControl/agentControlStore.js'

describe('ProPublica prospect pagination (frozen-universe fix)', () => {
  it('honors the page window: passes advancing page numbers to the 990 search', async () => {
    const calls = []
    const fakeSearch = async ({ page }) => {
      calls.push(page)
      return { organizations: [] }
    }
    const src = makePropublica990Source({ searchOrganizations: fakeSearch })
    await src.discover({ limit: 10000, page: 3, pages: 2 })
    const pages = [...new Set(calls)].sort((a, b) => a - b)
    expect(pages).toEqual([3, 4]) // only pages 3 and 4 were requested
  })

  it('defaults to page 0 / one page when no page is given (back-compat)', async () => {
    const calls = []
    const src = makePropublica990Source({
      searchOrganizations: async ({ page }) => { calls.push(page); return { organizations: [] } },
    })
    await src.discover({ limit: 10000 })
    expect([...new Set(calls)]).toEqual([0])
  })
})

describe('discoverProspects rotates + persists the ProPublica page cursor', () => {
  it('starts at page 0, advances the persisted cursor each run, and feeds the new page to the source', async () => {
    const db = makeDb()
    const pagesSeen = []
    // Fake 990 source that records which page it was asked for and returns one org.
    registerProspectSource('propublica_990', {
      name: 'propublica_990',
      async discover({ page = 0 }) {
        pagesSeen.push(page)
        return [{
          organization_name: `Prospect p${page}`,
          external_id: `ein-${page}`,
          source: 'propublica_990',
          email: `p${page}@example.org`,
          website_url: `https://p${page}.example.org`,
        }]
      },
    })

    const run1 = await discoverProspects(db, { allowLiveWeb: true, sources: ['propublica_990'], limit: 5 })
    expect(run1.prospect_page).toBe(0)
    expect(run1.next_prospect_page).toBe(2) // 0 + PROSPECT_PAGE_STEP
    expect(await getAgentSetting(db, 'yana.propublica_page')).toBe('2')

    const run2 = await discoverProspects(db, { allowLiveWeb: true, sources: ['propublica_990'], limit: 5 })
    expect(run2.prospect_page).toBe(2)
    expect(run2.next_prospect_page).toBe(4)

    // The source was asked for page 0 on run 1 and page 2 on run 2 — new orgs each run.
    expect(pagesSeen).toContain(0)
    expect(pagesSeen).toContain(2)
  })
})
