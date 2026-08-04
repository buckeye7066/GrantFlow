/**
 * Pointer research leads (owner directive 2026-08-04, the manual-handoff rule).
 *
 * A pointer-kind catalog row (directory / referral / school_portal /
 * past_award_intel) WITHOUT a usable web URL can never become an application:
 * there is nothing to fill and nothing to submit, so a task minted for it dies
 * silently. The policy refuses it as a RESEARCH LEAD carrying generated
 * handoff instructions; a pointer WITH a usable URL stays allowed because the
 * portal engine decomposes listings into real per-award candidates.
 *
 * ORDERING PIN (the wired-but-unreachable class): the research-lead branch
 * MUST run BEFORE the trust gate inside assessHamiltonFundingSource. A
 * URL-less row always trips trust's no_real_url (display=false), so with
 * trust first every research lead collapses into a generic
 * funding_source_disallowed — and the /api/application-tasks POST gate, which
 * only special-cases pointer_research_lead, would mint the task anyway. The
 * "end-to-end" tests here fail on that ordering, not just on a deleted branch.
 */

import express from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { assessPointerResearchLead, assessHamiltonFundingSource } =
  await import('../services/hamilton/hamiltonFundingSourcePolicy.js')
const { _resetSchemaCache, ensureApplicationTaskSchema } = await import('../services/hamilton/applicationTaskStore.js')
const tasksRouter = (await import('../routes/applicationTasks.js')).default

afterEach(() => {
  delete process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
})

describe('assessPointerResearchLead (pure)', () => {
  it('turns a URL-less pointer into a research lead with owner handoff instructions', () => {
    const lead = assessPointerResearchLead({
      opportunity_kind: 'DIRECTORY',
      title: 'Bradley County assistance programs',
    })
    expect(lead).not.toBeNull()
    expect(lead.kind).toBe('directory')
    expect(lead.url).toBeNull()
    // The instructions are the handoff: they name the source, say WHY it is
    // not applyable, and route the owner through Discovery for each real
    // program found.
    expect(lead.instructions).toContain('Bradley County assistance programs')
    expect(lead.instructions).toContain('Discovery')
  })

  it('returns null for a pointer WITH a usable URL — decomposition reaches it', () => {
    const lead = assessPointerResearchLead({
      opportunity_kind: 'directory',
      title: 'Bold.org scholarship listings',
      source_url: 'https://bold.org/scholarships/',
    })
    expect(lead).toBeNull()
  })

  it('becomes a research lead even WITH a URL when decomposition is disabled (the toggle is the reach)', () => {
    process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS = 'false'
    const lead = assessPointerResearchLead({
      opportunity_kind: 'directory',
      title: 'Bold.org scholarship listings',
      source_url: 'https://bold.org/scholarships/',
    })
    expect(lead).not.toBeNull()
    // With a URL on file the instructions hand the owner the link to open.
    expect(lead.instructions).toContain('https://bold.org/scholarships/')
  })

  it('never fires for a non-pointer kind or a kindless (grant-only) subject', () => {
    expect(assessPointerResearchLead({ opportunity_kind: 'direct_grant', title: 'Real grant' })).toBeNull()
    expect(assessPointerResearchLead({ title: 'Pipeline grant with no kind column' })).toBeNull()
  })

  it('folds the profile needs into the instructions so the research is aimed', () => {
    const lead = assessPointerResearchLead(
      { opportunity_kind: 'referral', title: 'Findhelp locator' },
      { profileNeeds: ['housing', 'food'] },
    )
    expect(lead.instructions).toContain('housing, food')
  })
})

describe('assessHamiltonFundingSource — research lead ordering', () => {
  let db
  beforeEach(() => {
    _resetSchemaCache()
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, sponsor TEXT,
        opportunity_kind TEXT, application_url TEXT, source_url TEXT,
        evidence_url TEXT, record_origin TEXT, is_active INTEGER DEFAULT 1
      );
    `)
  })

  it('refuses a URL-less pointer as pointer_research_lead (NOT the generic trust block) and carries the handoff', async () => {
    const res = await assessHamiltonFundingSource(db, {
      profileId: 'p-1',
      opportunity: {
        id: 'opp-1',
        title: 'Polk County, TN — Local assistance programs near you (findhelp)',
        opportunity_kind: 'directory',
        record_origin: 'curated_verified',
      },
    })
    expect(res.ok).toBe(false)
    // The PIN: trust would also refuse this row (no_real_url), but the caller
    // can only surface handoff instructions for pointer_research_lead — a
    // generic funding_source_disallowed here means the branch is unreachable.
    expect(res.code).toBe('pointer_research_lead')
    expect(res.handoff?.instructions).toContain('Polk County')
    expect(res.message).toContain('Discovery')
  })

  it('still trust-refuses a URL-less NON-pointer row — the reorder lowered no bar', async () => {
    const res = await assessHamiltonFundingSource(db, {
      profileId: 'p-1',
      opportunity: {
        id: 'opp-2',
        title: 'Real direct grant with no link stored',
        opportunity_kind: 'direct_grant',
        record_origin: 'curated_verified',
      },
    })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('funding_source_disallowed')
    expect(res.reasons).toContain('no_real_url')
  })

  it('allows a pointer WITH a usable URL through to the normal policy chain', async () => {
    const res = await assessHamiltonFundingSource(db, {
      profileId: 'p-1',
      opportunity: {
        id: 'opp-3',
        title: 'NGWeb scholarship catalog',
        opportunity_kind: 'directory',
        source_url: 'https://mtsu.scholarships.ngwebsolutions.com/',
        record_origin: 'curated_verified',
      },
    })
    expect(res.ok).toBe(true)
  })
})

describe('POST /api/application-tasks — pointer research leads are refused at create', () => {
  let db
  beforeEach(async () => {
    _resetSchemaCache()
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, sponsor TEXT,
        opportunity_kind TEXT, application_url TEXT, source_url TEXT,
        evidence_url TEXT, record_origin TEXT, is_active INTEGER DEFAULT 1
      );
      CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, funding_opportunity_id TEXT);
      INSERT INTO funding_opportunities (id, title, opportunity_kind, record_origin)
        VALUES ('opp-pointer', 'Eldercare Locator', 'referral', 'curated_verified');
      INSERT INTO funding_opportunities (id, title, opportunity_kind, source_url, record_origin)
        VALUES ('opp-listing', 'Bold.org scholarship listings', 'directory', 'https://bold.org/scholarships/', 'curated_verified');
    `)
    // Real application_tasks schema up front so "no task row was created" is a
    // readable assertion rather than a missing-table error.
    await ensureApplicationTaskSchema(db)
  })

  function app() {
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => {
      req.db = db
      req.user = { role: 'admin', userId: 'u-1' }
      req.ctx = { isAdmin: true }
      next()
    })
    a.use('/api/application-tasks', tasksRouter)
    return a
  }

  it('422s a URL-less pointer with the handoff instructions and creates NO task row', async () => {
    const res = await request(app())
      .post('/api/application-tasks')
      .send({ profile_id: 'p-1', opportunity_id: 'opp-pointer' })

    expect(res.status).toBe(422)
    expect(res.body.error).toBe('pointer_research_lead')
    expect(res.body.handoff?.instructions).toContain('Eldercare Locator')

    const count = db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get()
    expect(count.n).toBe(0)
  })

  it('creates the task for a pointer WITH a usable URL — decomposition keeps its lane', async () => {
    const res = await request(app())
      .post('/api/application-tasks')
      .send({ profile_id: 'p-1', opportunity_id: 'opp-listing' })

    expect(res.status).toBeLessThan(300)
    const count = db.prepare('SELECT COUNT(*) AS n FROM application_tasks').get()
    expect(count.n).toBe(1)
  })
})
