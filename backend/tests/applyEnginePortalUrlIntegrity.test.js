/**
 * Bug #1 — WRONG EXTERNAL PORTAL URL (live walkthrough 2026-08-03, Robert's
 * profile 6b3c75ec-dc56-46f9-b380-394172688175).
 *
 * Auto-populate shipped https://cpcc.academicworks.com/ (Central Piedmont
 * Community College, North Carolina) as "Portal URL on file" + the submission
 * instructions target for an opportunity attributed to "Cleveland State
 * Community College" (Tennessee). The URL sat on the grant/catalog row itself
 * (a web_search live-crawl misattribution, prod rows created 2026-07-28), and
 * autoPopulate copied it out unvetted — plus it would read a URL out of
 * grants.application_method, an off-vocabulary side door.
 *
 * House precedent: the canonical-program class — an application target may
 * only come from the row's own verified links, and a tenant-slug portal
 * domain the funder's own WHOLE name cannot explain (the Yana lead-contact
 * rule applied to slugs) is positive wrong-institution evidence: skip it,
 * leave the portal blank, and label it "unverified — confirm with funder".
 *
 * Fixtures below are the REAL prod row shapes (grants 869688b8…,
 * funding_opportunities 95db796d…), trimmed to the columns the engine reads.
 */

import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'

const Database = (await import('better-sqlite3')).default
const {
  autoPopulate,
  validateApplication,
  resolveVerifiedPortalUrl,
  upsertSection,
  setChecklistItem,
  PORTAL_URL_UNVERIFIED_LABEL,
} = await import('../apply/applyEngine.js')
const {
  portalUrlFunderPlausibility,
  slugMatchesFunderName,
  tenantPortalSlug,
} = await import('../config/urlRules.js')

process.env.APPLY_STORAGE_DIR = path.join(os.tmpdir(), `gf-apply-test-${crypto.randomUUID().slice(0, 8)}`)

function makeSqliteWrapper(db) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    exec(sql) {
      return db.exec(sql)
    },
    async withTransaction(fn) {
      db.exec('BEGIN')
      try {
        const result = await fn(this)
        db.exec('COMMIT')
        return result
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw e
      }
    },
  }
}

const ROBERT = '6b3c75ec-dc56-46f9-b380-394172688175'
const CPCC_URL = 'https://cpcc.academicworks.com/'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, state TEXT, city TEXT, zip_code TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT,
      source_url TEXT, application_url TEXT, evidence_url TEXT, apply_url TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, description TEXT,
      eligibility_bullets TEXT, eligibility_text TEXT, categories TEXT,
      amount_min REAL, amount_max REAL, deadline TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, organization_id TEXT, profile_id TEXT,
      funding_opportunity_id TEXT, title TEXT, funder TEXT,
      status TEXT DEFAULT 'discovered', url TEXT, application_url TEXT,
      portal_url TEXT, application_method TEXT, application_steps TEXT,
      deadline TEXT, amount_requested REAL, amount_max REAL,
      contact_name TEXT, contact_email TEXT, contact_phone TEXT,
      funder_fax TEXT, funder_address TEXT,
      program_description TEXT, eligibility_summary TEXT, selection_criteria TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, grant_id TEXT, organization_id TEXT, title TEXT,
      description TEXT, due_date DATE, completed BOOLEAN DEFAULT 0,
      completed_date DATE, type TEXT, reminder_days INTEGER DEFAULT 7,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO organizations (id, name) VALUES ('o-1', 'Robert Household');
    INSERT INTO profiles (id, display_name, primary_type, state) VALUES ('${ROBERT}', 'Robert', 'individual', 'TN');
  `)
  return makeSqliteWrapper(raw)
}

/** The real prod poisoned pair (2026-08-03 walkthrough). */
async function seedPoisonedRows(db) {
  await db.prepare(`
    INSERT INTO funding_opportunities (id, title, sponsor, source_url, application_url, evidence_url)
    VALUES ('95db796d7257b886185ac9d1b54b44a87a6140356f943f5d7289d34ddf7900e2',
            'Opportunity Scholars Program', 'Cleveland State Community College', ?, ?, ?)
  `).run(CPCC_URL, CPCC_URL, CPCC_URL)
  await db.prepare(`
    INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder,
                        status, url, application_url, application_method)
    VALUES ('869688b8-8110-45e2-ae83-9886015f8a1b', 'o-1', ?,
            '95db796d7257b886185ac9d1b54b44a87a6140356f943f5d7289d34ddf7900e2',
            'Opportunity Scholars Program', 'Cleveland State Community College',
            'discovered', ?, ?, 'portal')
  `).run(ROBERT, CPCC_URL, CPCC_URL)
  await db.prepare(`
    INSERT INTO applications (id, grant_id, organization_id, status)
    VALUES ('app-1', '869688b8-8110-45e2-ae83-9886015f8a1b', 'o-1', 'draft')
  `).run()
}

async function seedApplicationsSchema(db) {
  // applyEngine creates its own tables lazily; force it via a cheap call path
  // by creating them here in the same shape the engine expects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      submission_method TEXT,
      submitted_at DATETIME,
      exported_at DATETIME,
      portal_url TEXT,
      snapshot_json TEXT,
      artifact_uri TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(grant_id, organization_id)
    );
    CREATE TABLE IF NOT EXISTS application_sections (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, section_key TEXT NOT NULL,
      title TEXT, content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, section_key)
    );
    CREATE TABLE IF NOT EXISTS application_checklist_items (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, key TEXT NOT NULL,
      label TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, key)
    );
    CREATE TABLE IF NOT EXISTS application_artifacts (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, format TEXT NOT NULL,
      uri TEXT, byte_size INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(application_id, format)
    );
  `)
}

describe('portalUrlFunderPlausibility (tenant-slug whole-name rule)', () => {
  it('flags the live incident: cpcc.academicworks.com is NOT Cleveland State Community College', () => {
    expect(portalUrlFunderPlausibility(CPCC_URL, 'Cleveland State Community College')).toBe('implausible')
  })

  it('accepts real tenant slugs the institution name explains', () => {
    // Initialism (mtsu ← Middle Tennessee State University)
    expect(portalUrlFunderPlausibility('https://mtsu.academicworks.com/', 'Middle Tennessee State University')).toBe('plausible')
    // Ordered prefix blend (clscc ← CLeveland State Community College)
    expect(portalUrlFunderPlausibility('https://clscc.academicworks.com/', 'Cleveland State Community College')).toBe('plausible')
    // Full initialism (cscc)
    expect(slugMatchesFunderName('cscc', 'Cleveland State Community College')).toBe(true)
    // Whole-name concatenation
    expect(slugMatchesFunderName('clevelandstatecc', 'Cleveland State Community College')).toBe(true)
    // Stopword skipped (uwf ← University of West Florida)
    expect(slugMatchesFunderName('uwf', 'University of West Florida')).toBe(true)
    // Long prefix (upenn-style)
    expect(slugMatchesFunderName('upenn', 'University of Pennsylvania')).toBe(true)
  })

  it('cpcc is exactly the wrong-institution signature (no word of the funder name starts with p)', () => {
    expect(slugMatchesFunderName('cpcc', 'Cleveland State Community College')).toBe(false)
  })

  it('never flags outside tenant-slug platforms (undecidable, not implausible)', () => {
    expect(portalUrlFunderPlausibility('https://www.tn.gov/collegepays', 'Tennessee Student Assistance Corporation')).toBe('undecidable')
    expect(portalUrlFunderPlausibility('https://grants.gov/search', 'Anything At All')).toBe('undecidable')
    // Bare platform host carries no tenant claim.
    expect(portalUrlFunderPlausibility('https://academicworks.com/', 'Cleveland State Community College')).toBe('undecidable')
  })

  it('missing funder name is undecidable — silence is not a denial', () => {
    expect(portalUrlFunderPlausibility(CPCC_URL, '')).toBe('undecidable')
    expect(portalUrlFunderPlausibility(CPCC_URL, null)).toBe('undecidable')
  })

  it('tenantPortalSlug parses nested tenant hosts (NGWeb pattern)', () => {
    expect(tenantPortalSlug('https://mtsu.scholarships.ngwebsolutions.com/x')).toEqual({
      platform: 'ngwebsolutions.com',
      slug: 'mtsu',
    })
  })
})

describe('resolveVerifiedPortalUrl', () => {
  it('skips an implausible tenant URL and reports it flagged (live poisoned rows)', () => {
    const grant = {
      funder: 'Cleveland State Community College',
      url: CPCC_URL,
      application_url: CPCC_URL,
      application_method: 'portal',
    }
    const opp = { sponsor: 'Cleveland State Community College', source_url: CPCC_URL, application_url: CPCC_URL, evidence_url: CPCC_URL }
    const resolved = resolveVerifiedPortalUrl(grant, opp)
    expect(resolved.url).toBe(null)
    expect(resolved.flagged.length).toBeGreaterThan(0)
    expect(resolved.flagged[0].reason).toBe('portal_domain_not_funder')
  })

  it('keeps a row-verified plausible link', () => {
    const grant = { funder: 'Middle Tennessee State University', application_url: 'https://mtsu.academicworks.com/' }
    expect(resolveVerifiedPortalUrl(grant, null).url).toBe('https://mtsu.academicworks.com/')
  })

  it('keeps an undecidable (non-tenant) link — never blanks tn.gov-class URLs', () => {
    const grant = { funder: 'Tennessee Student Assistance Corporation', application_url: 'https://www.tn.gov/collegepays' }
    expect(resolveVerifiedPortalUrl(grant, null).url).toBe('https://www.tn.gov/collegepays')
  })

  it('NEVER reads a URL out of application_method (the off-vocabulary side door)', () => {
    const grant = { funder: 'Some Funder', application_method: 'https://minted.example/portal' }
    expect(resolveVerifiedPortalUrl(grant, null).url).toBe(null)
  })
})

describe('autoPopulate portal-target integrity (bug #1)', () => {
  let db
  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY // template path only — no network
    db = makeDb()
    await seedApplicationsSchema(db)
    await seedPoisonedRows(db)
  })

  it('leaves the portal blank + labeled unverified instead of shipping another institution\'s portal', async () => {
    const result = await autoPopulate({ db, applicationId: 'app-1' })
    expect(result.portal_url).toBe(null)
    expect(result.portal_url_status).toBe('unverified_flagged')
    expect(result.portal_url_flags.some((f) => f.url === CPCC_URL)).toBe(true)

    const app = await db.prepare('SELECT portal_url, snapshot_json FROM applications WHERE id = ?').get('app-1')
    expect(app.portal_url).toBe(null)
    const snapshot = JSON.parse(app.snapshot_json)
    expect(snapshot.auto_populate.portal_url_status).toBe('unverified_flagged')
    expect(snapshot.auto_populate.portal_url_unverified_label).toBe(PORTAL_URL_UNVERIFIED_LABEL)
  })

  it('CLEARS a previously stored wrong portal_url on re-populate', async () => {
    await db.prepare('UPDATE applications SET portal_url = ? WHERE id = ?').run(CPCC_URL, 'app-1')
    await autoPopulate({ db, applicationId: 'app-1' })
    const app = await db.prepare('SELECT portal_url FROM applications WHERE id = ?').get('app-1')
    expect(app.portal_url).toBe(null)
  })

  it('the submit checklist item carries the unverified label, never the wrong URL', async () => {
    await autoPopulate({ db, applicationId: 'app-1' })
    const item = await db
      .prepare("SELECT label FROM application_checklist_items WHERE application_id = ? AND key = 'submit_application'")
      .get('app-1')
    expect(item.label).toContain(PORTAL_URL_UNVERIFIED_LABEL)
    expect(item.label).not.toContain('cpcc')
  })

  it('still populates a plausible portal from the row\'s own verified link', async () => {
    await db.prepare(`
      INSERT INTO grants (id, organization_id, profile_id, title, funder, status, application_url, application_method)
      VALUES ('g-mtsu', 'o-1', ?, 'MTSU Foundation Scholarship', 'Middle Tennessee State University',
              'discovered', 'https://mtsu.academicworks.com/', 'portal')
    `).run(ROBERT)
    await db.prepare(`
      INSERT INTO applications (id, grant_id, organization_id, status) VALUES ('app-2', 'g-mtsu', 'o-1', 'draft')
    `).run()
    const result = await autoPopulate({ db, applicationId: 'app-2' })
    expect(result.portal_url).toBe('https://mtsu.academicworks.com/')
    expect(result.portal_url_status).toBe('verified_row_link')
  })
})

describe('validateApplication portal-domain flag (bug #1 validation net)', () => {
  let db
  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY
    db = makeDb()
    await seedApplicationsSchema(db)
    await seedPoisonedRows(db)
  })

  it('an otherwise-ready application with an implausible stored portal_url is NOT ready and names the flag', async () => {
    await db.prepare('UPDATE applications SET portal_url = ? WHERE id = ?').run(CPCC_URL, 'app-1')
    await upsertSection({ db, applicationId: 'app-1', sectionKey: 'personal_statement', title: 'Personal Statement', content: 'Real content.' })
    await setChecklistItem({ db, applicationId: 'app-1', key: 'final_review', label: 'Final review', status: 'done' })

    const validation = await validateApplication({ db, applicationId: 'app-1' })
    expect(validation.portal_url_flags.length).toBe(1)
    expect(validation.portal_url_flags[0].reason).toBe('portal_domain_not_funder')
    expect(validation.portal_url_flags[0].message).toContain(PORTAL_URL_UNVERIFIED_LABEL)
    expect(validation.ready).toBe(false)
  })

  it('a plausible or non-tenant portal_url raises no flag', async () => {
    await db.prepare('UPDATE applications SET portal_url = ? WHERE id = ?').run('https://www.tn.gov/collegepays', 'app-1')
    const validation = await validateApplication({ db, applicationId: 'app-1' })
    expect(validation.portal_url_flags).toEqual([])
  })
})
