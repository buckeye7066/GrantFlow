/**
 * Tests for the new "Automate with Hamilton" select-many flow:
 *
 *   - hamiltonAutomationClassifier.classifyFundingSource — every pathway
 *   - hamiltonApplicationPacketGenerator — content + DOCX persistence + missing-info
 *   - hamiltonAutomationOrchestrator.automateSelected — multi-source dispatch,
 *     across pipeline stages, with task creation and audit events.
 *
 * The tests run against an in-memory SQLite database that mirrors the
 * shape `applicationTaskStore.ensureApplicationTaskSchema` builds and
 * adds enough of the surrounding schema (profiles, profile_sections,
 * funding_opportunities, grants, documents, profile_documents,
 * notifications, users) for the orchestrator's reads/writes.
 *
 * Profile scoping is verified end-to-end (a task created for profile A
 * never appears under profile B's tasks).
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { classifyFundingSource } from '../../backend/services/hamilton/hamiltonAutomationClassifier.js'
import {
  buildPacketContent,
  buildMailingInstructions,
  buildHtml,
  buildDocxBuffer,
  generateAndSavePacket,
} from '../../backend/services/hamilton/hamiltonApplicationPacketGenerator.js'
import {
  automateSelected,
  automateSingleSource,
} from '../../backend/services/hamilton/hamiltonAutomationOrchestrator.js'
import {
  listApplicationTasks,
  countApplicationTaskBuckets,
  getApplicationTask,
  _resetSchemaCache,
} from '../../backend/services/hamilton/applicationTaskStore.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/hamilton/hamiltonNotifications.js'
import { _resetAuthSchemaCache } from '../../backend/services/hamilton/hamiltonAuthorizationStore.js'

function makeMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      organization_id TEXT,
      display_name TEXT,
      primary_type TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_sections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS funding_opportunities (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, description TEXT,
      application_url TEXT, application_mode TEXT,
      mailing_address TEXT, apply_email TEXT, apply_fax TEXT,
      funder_name TEXT, deadline TEXT, eligibility_text TEXT,
      result_kind TEXT, opportunity_kind TEXT,
      entity_types_allowed TEXT NOT NULL DEFAULT '["individual","student"]',
      need_types_supported TEXT NOT NULL DEFAULT '["education"]',
      categories TEXT NOT NULL DEFAULT '["education"]',
      record_origin TEXT NOT NULL DEFAULT 'verified_real',
      source_trust_tier TEXT NOT NULL DEFAULT 'verified',
      reality_status TEXT NOT NULL DEFAULT 'verified',
      reality_reasons TEXT NOT NULL DEFAULT '[]',
      link_status TEXT NOT NULL DEFAULT 'ok',
      last_verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      matcher_version TEXT,
      updated_at TEXT,
      computed_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );
    -- These pathway tests start after crawler qualification. Seed that explicit
    -- precondition for every inserted source without weakening production policy.
    CREATE TRIGGER accept_inserted_test_opportunity
    AFTER INSERT ON funding_opportunities
    BEGIN
      INSERT OR REPLACE INTO profile_opportunity_matches
        (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
      VALUES
        ('p-A', NEW.id, 95, 'accept', 'Crawler OS approved this fixture for profile A.', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT OR REPLACE INTO profile_opportunity_matches
        (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
      VALUES
        ('p-B', NEW.id, 95, 'accept', 'Crawler OS approved this fixture for profile B.', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    END;
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, profile_id TEXT, status TEXT,
      application_url TEXT, opportunity_id TEXT, title TEXT,
      updated_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, profile_id TEXT, organization_id TEXT,
      grant_id TEXT, name TEXT, type TEXT,
      file_url TEXT, file_path TEXT, file_size INTEGER, mime_type TEXT,
      extracted_text TEXT, processing_status TEXT, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS profile_documents (
      profile_id TEXT, document_id TEXT,
      PRIMARY KEY (profile_id, document_id)
    );
    INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES ('p-A', 'u-A', 'Profile A', 'college_student');
    INSERT INTO profiles (id, user_id, display_name, primary_type) VALUES ('p-B', 'u-B', 'Profile B', 'college_student');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-bi', 'p-A', 'basic_information',
              '{"first_name":"Anya","last_name":"K","email":"anya@example.com","address1":"100 Main St","city":"Murfreesboro","state":"TN","zip":"37130"}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-ua', 'p-A', 'university_applications',
              '{"applications":[{"name":"Middle Tennessee State University","major":"Biology","status":"committed"}]}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-essays', 'p-A', 'essays',
              '{"primary":"My personal statement explaining how I came to this point in my education."}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-needs', 'p-A', 'financial_information',
              '{"needs":["education"]}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-education', 'p-A', 'education',
              '{"current_institution":"Middle Tennessee State University","intended_major":"Biology","gpa":3.8}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-B-needs', 'p-B', 'financial_information',
              '{"needs":["education"]}');
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...params) => stmt.get(...params),
        all: async (...params) => stmt.all(...params),
        run: async (...params) => {
          const r = stmt.run(...params)
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
        },
      }
    },
    exec(sql) { sqlite.exec(sql) },
    raw: sqlite,
  }
}

function resetCaches() {
  _resetSchemaCache()
  _resetNotificationsSchemaCache()
  _resetAuthSchemaCache()
}

before(() => {
  // Use a tmp packet storage dir so we don't litter the repo.
  process.env.HAMILTON_PACKET_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hamilton-packet-test-'))
})

describe('hamiltonAutomationClassifier — every pathway', () => {
  it('classifies explicit application_mode=portal as portal', () => {
    const r = classifyFundingSource({
      opportunity: { application_mode: 'portal', application_url: 'https://www.mtsu.edu/financial-aid/apply' },
    })
    assert.equal(r.automation_type, 'portal')
    assert.ok(r.confidence >= 0.9)
  })

  it('classifies explicit application_mode=mail as mail', () => {
    const r = classifyFundingSource({
      opportunity: { application_mode: 'mail', mailing_address: '123 Foundation Way' },
    })
    assert.equal(r.automation_type, 'mail')
    assert.equal(r.mailing_address, '123 Foundation Way')
  })

  it('classifies FAFSA-mentioning text as auto_profile', () => {
    const r = classifyFundingSource({
      opportunity: {
        title: 'University Need-Based Aid',
        description: 'Awarded automatically based on FAFSA results.',
      },
    })
    assert.equal(r.automation_type, 'auto_profile')
  })

  it('classifies fax-only sources as fax when fax number is present', () => {
    const r = classifyFundingSource({
      opportunity: {
        title: 'County Hardship Fund',
        description: 'Submit completed application by fax to (555) 123-4567 by Friday.',
      },
    })
    assert.equal(r.automation_type, 'fax')
  })

  it('classifies email-instruction text as email', () => {
    const r = classifyFundingSource({
      opportunity: {
        title: 'Local Foundation',
        description: 'Please email completed application to grants@localfoundation.org.',
        apply_email: 'grants@localfoundation.org',
      },
    })
    assert.equal(r.automation_type, 'email')
    assert.equal(r.apply_email, 'grants@localfoundation.org')
  })

  it('classifies PDF URLs as pdf_docx', () => {
    const r = classifyFundingSource({
      opportunity: { application_url: 'https://example.org/apps/2026-form.pdf' },
    })
    assert.equal(r.automation_type, 'pdf_docx')
  })

  it('classifies http URLs without obvious format as portal', () => {
    const r = classifyFundingSource({
      opportunity: { application_url: 'https://www.mtsu.edu/financial-aid/apply' },
    })
    assert.equal(r.automation_type, 'portal')
  })

  it('classifies directory result_kind as no_application', () => {
    const r = classifyFundingSource({
      opportunity: { result_kind: 'directory', title: 'Directory of Tennessee scholarships' },
    })
    assert.equal(r.automation_type, 'no_application')
  })

  it('classifies opportunities with no recognised channel as unknown', () => {
    const r = classifyFundingSource({ opportunity: { title: 'Unspecified' } })
    assert.equal(r.automation_type, 'unknown')
  })

  // URL hygiene: a search-engine RESULTS url is never an application target.
  // Legacy rows persisted "google.com/search?q=<school> financial aid office"
  // as application_url and Hamilton drove the login flow against Google's
  // sign-in wall. The classifier must skip such URLs entirely.
  it('never resolves a search-engine results URL — classifies as unknown, resolved_url null', () => {
    const r = classifyFundingSource({
      opportunity: {
        title: 'Middle Tennessee State University — Financial Aid',
        application_url: 'https://www.google.com/search?q=Middle+Tennessee+State+University+financial+aid+office',
      },
    })
    assert.equal(r.automation_type, 'unknown')
    assert.equal(r.resolved_url, null)
  })

  it('skips a search-engine application_url but still uses a real fallback URL', () => {
    const r = classifyFundingSource({
      opportunity: {
        title: 'MTSU Financial Aid',
        application_url: 'https://www.bing.com/search?q=mtsu+financial+aid',
        source_url: 'https://www.mtsu.edu/financial-aid/',
      },
    })
    assert.equal(r.automation_type, 'portal')
    assert.equal(r.resolved_url, 'https://www.mtsu.edu/financial-aid/')
  })

  it('explicit portal mode with only a search-results URL yields resolved_url null (nothing to log into)', () => {
    const r = classifyFundingSource({
      opportunity: {
        application_mode: 'portal',
        application_url: 'https://duckduckgo.com/?q=college+grants',
      },
    })
    assert.equal(r.automation_type, 'portal')
    assert.equal(r.resolved_url, null)
  })
})

describe('hamiltonApplicationPacketGenerator — content + DOCX', () => {
  it('flags missing personal statement when essays are absent', () => {
    const content = buildPacketContent({
      profile: { id: 'p', basic_information: { first_name: 'A', last_name: 'B' } },
      opportunity: { title: 'Test Award', funder_name: 'Test Funder' },
      automationType: 'pdf_docx',
    })
    const flagged = content.missing.find((m) => m.key === 'personal_statement')
    assert.ok(flagged, 'personal_statement flagged when essay is missing')
  })

  it('does not flag personal statement when profile has it', () => {
    const content = buildPacketContent({
      profile: {
        id: 'p',
        basic_information: { first_name: 'A', last_name: 'B' },
        essays: { primary: 'A real essay.' },
      },
      opportunity: { title: 'Test', funder_name: 'F' },
      automationType: 'pdf_docx',
    })
    const flagged = content.missing.find((m) => m.key === 'personal_statement')
    assert.equal(flagged, undefined)
  })

  it('builds mail instructions including the funder address', () => {
    const m = buildMailingInstructions({
      opportunity: {
        title: 'Award', funder_name: 'F', mailing_address: '1 Main St',
        deadline: '2026-12-01',
      },
      automationType: 'mail',
    })
    assert.equal(m.automation_type, 'mail')
    assert.equal(m.mailing_address, '1 Main St')
    assert.ok(m.instructions.some((l) => l.includes('1 Main St')))
    assert.ok(m.instructions.some((l) => l.toLowerCase().includes('postmark')))
  })

  it('renders HTML with section headings', () => {
    const html = buildHtml({
      title: 'Application',
      sections: [{ heading: 'Statement of Need', body: 'Body text' }],
      mailingInstructions: { instructions: ['Mail it'] },
    })
    assert.ok(html.includes('<h2>Statement of Need</h2>'))
    assert.ok(html.includes('Mail it'))
  })

  it('builds a non-empty DOCX buffer with the standard parts', async () => {
    const buf = await buildDocxBuffer({
      title: 'My Application',
      sections: [{ heading: 'A', body: 'B' }],
      mailingInstructions: { instructions: ['One', 'Two'] },
    })
    assert.ok(Buffer.isBuffer(buf), 'returns a Buffer')
    assert.ok(buf.length > 200, 'buffer is non-trivial')
  })

  it('persists DOCX (and optionally PDF) into documents + profile_documents', async () => {
    resetCaches()
    const db = makeMemoryDb()
    const profile = {
      id: 'p-A',
      basic_information: { first_name: 'Anya', last_name: 'K', email: 'a@example.com' },
      essays: { primary: 'My narrative.' },
    }
    const result = await generateAndSavePacket(db, {
      profile,
      opportunity: { id: 'opp-1', title: 'Award', funder_name: 'Funder', application_mode: 'pdf_docx' },
      automationType: 'pdf_docx',
      taskId: 't-1',
      userId: 'u-A',
    })
    assert.ok(result.docx_document_id, 'returns a DOCX document id')
    const docs = db.raw.prepare('SELECT * FROM documents WHERE profile_id = ?').all('p-A')
    assert.ok(docs.length >= 1, 'document row inserted')
    const link = db.raw.prepare('SELECT * FROM profile_documents WHERE profile_id = ? AND document_id = ?').get('p-A', result.docx_document_id)
    assert.ok(link, 'profile_documents link inserted')
  })
})

describe('hamiltonAutomationOrchestrator — multi-source dispatch', () => {
  it('automates a mail source: creates a task, generates DOCX, sets ready_to_print_mail, with mailing instructions', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-mail', 'MTSU County Education Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University; submit the application by mail.', '1 Main St', 'mail', 'County Foundation', 'https://www.mtsu.edu/financial-aid/county-aid', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    const result = await automateSelected(db, {
      profileId: 'p-A',
      userId: 'u-A',
      selectedSources: [{ opportunity_id: 'opp-mail', current_stage: 'discovered' }],
    })
    assert.equal(result.ok, true)
    assert.equal(result.results.length, 1)
    const r0 = result.results[0]
    assert.equal(r0.classification.automation_type, 'mail')
    assert.equal(r0.task.automation_type, 'mail')
    assert.equal(r0.task.selected_from_stage, 'discovered')
    assert.equal(r0.task.status, 'ready_to_print_mail')
    assert.ok(r0.task.output_docx_document_id, 'docx saved')
    assert.ok(r0.task.mailing_instructions?.instructions?.length > 0, 'mailing instructions populated')
  })

  it('automates an email source: ready_to_email + apply_email captured', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, apply_email, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-email', 'MTSU Local Foundation Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University; email the completed packet.', 'grants@local.org', 'email', 'Local Foundation', 'https://www.mtsu.edu/financial-aid/local-foundation', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-email', current_stage: 'interested' },
    })
    assert.equal(result.task.automation_type, 'email')
    assert.equal(result.task.status, 'ready_to_email')
    assert.equal(result.task.mailing_instructions.email, 'grants@local.org')
  })

  // A DIRECTORY with no usable application URL is a POINTER — a research lead,
  // not a leaf application (the pointer/listing policy). It is refused BEFORE a
  // task is created, so no task and no files exist. This test previously
  // asserted the pre-policy contract (a completed no_application task) and had
  // been red on main since the pointer gate landed.
  it('a pointer directory with no usable URL is a RESEARCH LEAD: no task, no files', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, result_kind, application_mode, funder_name)
                    VALUES ('opp-dir', 'TN Scholarships Directory', 'Awareness resource', 'directory', 'no_application', 'TN Dept of Ed')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-dir', current_stage: 'saved' },
    })
    assert.equal(result.task, null, 'no leaf application task is created for a pointer')
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'pointer_research_lead')
    // The refusal is EXPLAINED, not silent — the caller can surface the next step.
    assert.equal(result.policy.code, 'pointer_research_lead')
    const docs = db.raw.prepare('SELECT COUNT(*) AS n FROM documents').get()
    assert.equal(docs.n, 0, 'no packet is generated for a research lead')
  })

  // The action-packet pathway itself is still reachable for a NON-pointer
  // source that declares it takes no application — keeping the coverage the
  // directory case used to provide.
  it('automates a no_application source: marks completed without generating files', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-noapp', 'MTSU Automatic Tuition Waiver', 'A direct education tuition award for eligible Tennessee college students at Middle Tennessee State University, awarded from student records with no separate application.', 'no_application', 'TN Dept of Ed', 'https://www.mtsu.edu/financial-aid/automatic-tuition-waiver', 'Eligible Tennessee college students at Middle Tennessee State University qualify automatically.')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-noapp', current_stage: 'saved' },
    })
    assert.equal(result.task.automation_type, 'no_application')
    assert.equal(result.task.status, 'completed')
    assert.equal(result.task.output_docx_document_id, null)
  })

  it('automates an auto_profile/FAFSA source with the FAFSA ON FILE: completed without inventing paperwork', async () => {
    resetCaches()
    const db = makeMemoryDb()
    // FAFSA-link recognition (2026-07-27): "completed" is only honest when
    // the profile actually HAS a FAFSA to link — seed it.
    db.raw.prepare(`INSERT INTO profile_sections (id, profile_id, section_key, data)
                    VALUES ('ps-A-edu-fafsa', 'p-A', 'education', '{"fafsa_completed": true}')`).run()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_mode, funder_name, application_url)
                    VALUES ('opp-fafsa', 'University Need Aid', 'Awarded based on FAFSA results.', 'auto_profile', 'University', 'https://studentaid.gov/h/apply-for-aid/fafsa')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-fafsa', current_stage: 'submitted' },
    })
    assert.equal(result.classification.automation_type, 'auto_profile')
    assert.equal(result.task.status, 'completed')
  })

  it('an auto_profile/FAFSA-link source with NO FAFSA on file parks with ONE honest ask (never fake-completes)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_mode, funder_name, application_url)
                    VALUES ('opp-fafsa-2', 'University Need Aid', 'Awarded based on FAFSA results.', 'auto_profile', 'University', 'https://studentaid.gov/h/apply-for-aid/fafsa')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-fafsa-2', current_stage: 'submitted' },
    })
    assert.equal(result.classification.automation_type, 'auto_profile')
    // Parked resumable: submitting the FAFSA later auto-resolves the ask via
    // reconcileProfileFieldsToTasks and the task resumes on its own.
    assert.equal(result.task.status, 'waiting_for_missing_info')
  })

  it('handles a portal source: when browser automation is disabled, marks ready_to_start with portal_url', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_url, application_mode, funder_name, eligibility_text)
                    VALUES ('opp-portal', 'MTSU Student Scholarship Portal', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', 'https://www.mtsu.edu/financial-aid/apply', 'portal', 'Funder', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    const prev = process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
    delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
    try {
      const result = await automateSingleSource(db, {
        profileId: 'p-A',
        userId: 'u-A',
        source: { opportunity_id: 'opp-portal', current_stage: 'gathering_documents' },
      })
      assert.equal(result.task.automation_type, 'portal')
      assert.equal(result.task.status, 'ready_to_start')
      assert.equal(result.task.portal_url, 'https://www.mtsu.edu/financial-aid/apply')
    } finally {
      if (prev !== undefined) process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION = prev
    }
  })

  it('refuses an unverifiable unknown source before creating work', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description) VALUES ('opp-?', 'No info', 'Nothing actionable')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-?', current_stage: 'discovered' },
    })
    assert.equal(result.task, null)
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'funding_source_disallowed')
    assert.ok(result.policy.reasons.includes('no_real_url'))
    assert.equal((await listApplicationTasks(db, { profileId: 'p-A' })).length, 0)
  })

  it('does NOT block based on selected pipeline stage — accepts every stage from discovered through awarded', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-anytime', 'MTSU Stage-Agnostic Education Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', '1 Main', 'mail', 'F', 'https://www.mtsu.edu/financial-aid/stage-agnostic-award', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    const stages = ['discovered', 'saved', 'interested', 'gathering_documents', 'drafting', 'ready_to_submit', 'submitted', 'follow_up', 'awarded']
    for (const stage of stages) {
      const r = await automateSingleSource(db, {
        profileId: 'p-A', userId: 'u-A',
        source: { opportunity_id: 'opp-anytime', current_stage: stage },
      })
      assert.equal(r.task.automation_type, 'mail',
        `stage ${stage} should still be classified, got status=${r.task.status}`)
      assert.equal(r.task.selected_from_stage, stage,
        `selected_from_stage should be persisted (${stage})`)
    }
    // Single task should exist (re-selected from different stages → upserts on the same row).
    const tasks = await listApplicationTasks(db, { profileId: 'p-A' })
    assert.equal(tasks.length, 1, 'reselecting from different stages should reuse the same task')
  })

  it('refuses an authoritative submitted grant before creating a duplicate task', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, mailing_address, application_mode, funder_name)
                    VALUES ('opp-protected', 'Already sent award', '1 Main', 'mail', 'F')`).run()
    db.raw.prepare(`INSERT INTO grants (id, profile_id, status, opportunity_id, title, updated_at)
                    VALUES ('grant-protected', 'p-A', 'submitted', 'opp-protected', 'Already sent award', CURRENT_TIMESTAMP)`).run()

    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: {
        grant_id: 'grant-protected',
        opportunity_id: 'opp-protected',
        current_stage: 'ready_to_submit',
      },
    })

    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'pipeline_stage_protected')
    assert.equal(result.pipeline_stage, 'submitted')
    assert.equal(result.task, null)
    assert.equal((await listApplicationTasks(db, { profileId: 'p-A' })).length, 0)
  })

  it('rejects a grant that belongs to another profile', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO grants (id, profile_id, status, title, updated_at)
                    VALUES ('grant-other-profile', 'p-B', 'saved', 'Private source', CURRENT_TIMESTAMP)`).run()

    await assert.rejects(
      automateSingleSource(db, {
        profileId: 'p-A',
        userId: 'u-A',
        source: { grant_id: 'grant-other-profile', current_stage: 'saved' },
      }),
      (error) => error?.code === 'source_profile_mismatch' && error?.status === 403,
    )
    assert.equal((await listApplicationTasks(db, { profileId: 'p-A' })).length, 0)
  })

  it('keeps tasks scoped to the profile (no cross-profile leak)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-pm', 'MTSU Profile-Scoped Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', '1 MTSU Blvd', 'mail', 'Middle Tennessee State University', 'https://www.mtsu.edu/financial-aid/profile-scope-award', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    await automateSingleSource(db, {
      profileId: 'p-A', userId: 'u-A',
      source: { opportunity_id: 'opp-pm', current_stage: 'discovered' },
    })
    const tasksA = await listApplicationTasks(db, { profileId: 'p-A' })
    const tasksB = await listApplicationTasks(db, { profileId: 'p-B' })
    assert.equal(tasksA.length, 1)
    assert.equal(tasksB.length, 0)
  })

  it('appends audit events for every classification + outcome', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('opp-audit', 'MTSU Audit Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', '1 MTSU Blvd', 'mail', 'Middle Tennessee State University', 'https://www.mtsu.edu/financial-aid/audit-award', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    const r = await automateSingleSource(db, {
      profileId: 'p-A', userId: 'u-A',
      source: { opportunity_id: 'opp-audit', current_stage: 'discovered' },
    })
    const events = db.raw.prepare('SELECT * FROM application_task_events WHERE task_id = ?').all(r.task.id)
    assert.ok(events.length >= 2, 'multiple audit events recorded')
    const types = new Set(events.map((e) => e.event_type))
    assert.ok(types.has('created'))
    assert.ok(types.has('progress'))
  })

  it('returns one row per source for bulk select-many (mixed pathways)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_url, application_mode, funder_name, eligibility_text)
                    VALUES ('o-portal', 'MTSU Portal Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', 'https://www.mtsu.edu/financial-aid/portal-application', 'portal', 'Middle Tennessee State University', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name, application_url, eligibility_text)
                    VALUES ('o-mail', 'MTSU Mail Scholarship', 'A direct education scholarship for eligible Tennessee college students enrolled at Middle Tennessee State University.', '1 MTSU Blvd', 'mail', 'Middle Tennessee State University', 'https://www.mtsu.edu/financial-aid/mail-award', 'Eligible Tennessee college students at Middle Tennessee State University may apply.')`).run()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, result_kind, funder_name)
                    VALUES ('o-dir', 'Scholarship Directory', 'directory', 'directory', 'F')`).run()
    delete process.env.HAMILTON_ENABLE_BROWSER_AUTOMATION
    const result = await automateSelected(db, {
      profileId: 'p-A', userId: 'u-A',
      selectedSources: [
        { opportunity_id: 'o-portal', current_stage: 'discovered' },
        { opportunity_id: 'o-mail', current_stage: 'discovered' },
        { opportunity_id: 'o-dir', current_stage: 'saved' },
      ],
    })
    assert.equal(result.results.length, 3)
    assert.equal(result.results[0].task.automation_type, 'portal')
    assert.equal(result.results[1].task.automation_type, 'mail')
    assert.equal(result.results[2].task, null)
    assert.equal(result.results[2].skipped, true)
    assert.equal(result.results[2].reason, 'pointer_research_lead')
    // Only leaf sources produce application tasks; the directory stays a
    // research lead for discovery decomposition.
    const tasks = await listApplicationTasks(db, { profileId: 'p-A' })
    assert.equal(tasks.length, 2)
    // Re-fetching each task by id returns the persisted shape.
    for (const r of result.results.filter((entry) => entry.task)) {
      const fresh = await getApplicationTask(db, r.task.id)
      assert.equal(fresh.id, r.task.id)
      assert.ok(fresh.automation_type)
    }
  })

  it('does not hide an old unfinished task behind more than 500 newer history rows', async () => {
    resetCaches()
    const db = makeMemoryDb()
    // Bootstrap the task schema, then model the production shape that exposed
    // the bug: recent terminal history outnumbers the mixed-list limit.
    await listApplicationTasks(db, { profileId: 'p-A', withSubmissionProof: false })
    const insert = db.raw.prepare(`
      INSERT INTO application_tasks
        (id, profile_id, opportunity_id, status, updated_at)
      VALUES (?, 'p-A', ?, ?, ?)
    `)
    const seed = db.raw.transaction(() => {
      for (let i = 0; i < 501; i += 1) {
        insert.run(`history-${i}`, `history-opportunity-${i}`, 'completed', '2026-09-02T12:00:00.000Z')
      }
      insert.run('old-current', 'old-current-opportunity', 'queued', '2020-01-01T00:00:00.000Z')
    })
    seed()

    const mixedSlice = await listApplicationTasks(db, {
      profileId: 'p-A',
      limit: 500,
      withSubmissionProof: false,
    })
    assert.equal(mixedSlice.some((task) => task.id === 'old-current'), false)

    const current = await listApplicationTasks(db, {
      profileId: 'p-A',
      taskBucket: 'current',
      limit: null,
      withSubmissionProof: false,
    })
    const history = await listApplicationTasks(db, {
      profileId: 'p-A',
      taskBucket: 'finished',
      limit: 500,
      withSubmissionProof: false,
    })
    const counts = await countApplicationTaskBuckets(db, { profileId: 'p-A' })

    assert.deepEqual(current.map((task) => task.id), ['old-current'])
    assert.equal(history.length, 500)
    assert.equal(counts.working, 1)
    assert.equal(counts.finished, 501)
    assert.equal(counts.total, 502)
  })
})
