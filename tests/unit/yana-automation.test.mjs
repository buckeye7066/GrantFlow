/**
 * Tests for the new "Automate with Yana" select-many flow:
 *
 *   - yanaAutomationClassifier.classifyFundingSource — every pathway
 *   - yanaApplicationPacketGenerator — content + DOCX persistence + missing-info
 *   - yanaAutomationOrchestrator.automateSelected — multi-source dispatch,
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

import { classifyFundingSource } from '../../backend/services/yana/yanaAutomationClassifier.js'
import {
  buildPacketContent,
  buildMailingInstructions,
  buildHtml,
  buildDocxBuffer,
  generateAndSavePacket,
} from '../../backend/services/yana/yanaApplicationPacketGenerator.js'
import {
  automateSelected,
  automateSingleSource,
} from '../../backend/services/yana/yanaAutomationOrchestrator.js'
import {
  listApplicationTasks,
  getApplicationTask,
  _resetSchemaCache,
} from '../../backend/services/yana/applicationTaskStore.js'
import { _resetNotificationsSchemaCache } from '../../backend/services/yana/yanaNotifications.js'
import { _resetAuthSchemaCache } from '../../backend/services/yana/yanaAuthorizationStore.js'

function makeMemoryDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      organization_id TEXT,
      display_name TEXT
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
      id TEXT PRIMARY KEY, title TEXT, description TEXT,
      application_url TEXT, application_mode TEXT,
      mailing_address TEXT, apply_email TEXT, apply_fax TEXT,
      funder_name TEXT, deadline TEXT, eligibility_text TEXT,
      result_kind TEXT, opportunity_kind TEXT
    );
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
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-A', 'u-A', 'Profile A');
    INSERT INTO profiles (id, user_id, display_name) VALUES ('p-B', 'u-B', 'Profile B');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-bi', 'p-A', 'basic_information',
              '{"first_name":"Anya","last_name":"K","email":"anya@example.com","address1":"100 Main St","city":"Murfreesboro","state":"TN","zip":"37130"}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-ua', 'p-A', 'university_applications',
              '{"applications":[{"name":"Middle Tennessee State University","major":"Biology","status":"committed"}]}');
    INSERT INTO profile_sections (id, profile_id, section_key, data)
      VALUES ('ps-A-essays', 'p-A', 'essays',
              '{"primary":"My personal statement explaining how I came to this point in my education."}');
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
  process.env.YANA_PACKET_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yana-packet-test-'))
})

describe('yanaAutomationClassifier — every pathway', () => {
  it('classifies explicit application_mode=portal as portal', () => {
    const r = classifyFundingSource({
      opportunity: { application_mode: 'portal', application_url: 'https://example.com/apply' },
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
      opportunity: { application_url: 'https://example.com/apply' },
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
})

describe('yanaApplicationPacketGenerator — content + DOCX', () => {
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

describe('yanaAutomationOrchestrator — multi-source dispatch', () => {
  it('automates a mail source: creates a task, generates DOCX, sets ready_to_print_mail, with mailing instructions', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, mailing_address, application_mode, funder_name)
                    VALUES ('opp-mail', 'County Aid', 'Mail-in form', '1 Main St', 'mail', 'County Foundation')`).run()
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
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, apply_email, application_mode, funder_name)
                    VALUES ('opp-email', 'Local Foundation', 'Email completed packet', 'grants@local.org', 'email', 'Local Foundation')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-email', current_stage: 'interested' },
    })
    assert.equal(result.task.automation_type, 'email')
    assert.equal(result.task.status, 'ready_to_email')
    assert.equal(result.task.mailing_instructions.email, 'grants@local.org')
  })

  it('automates a no_application directory: marks completed without generating files', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, result_kind, application_mode, funder_name)
                    VALUES ('opp-dir', 'TN Scholarships Directory', 'Awareness resource', 'directory', 'no_application', 'TN Dept of Ed')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-dir', current_stage: 'saved' },
    })
    assert.equal(result.task.automation_type, 'no_application')
    assert.equal(result.task.status, 'completed')
    assert.equal(result.task.output_docx_document_id, null)
  })

  it('automates an auto_profile/FAFSA source: completed without inventing paperwork', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, application_mode, funder_name)
                    VALUES ('opp-fafsa', 'University Need Aid', 'Awarded based on FAFSA results.', 'auto_profile', 'University')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-fafsa', current_stage: 'submitted' },
    })
    assert.equal(result.classification.automation_type, 'auto_profile')
    assert.equal(result.task.status, 'completed')
  })

  it('handles a portal source: when browser automation is disabled, marks ready_to_start with portal_url', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, application_url, application_mode, funder_name)
                    VALUES ('opp-portal', 'Scholarship Portal', 'https://example.com/apply', 'portal', 'Funder')`).run()
    const prev = process.env.YANA_ENABLE_BROWSER_AUTOMATION
    delete process.env.YANA_ENABLE_BROWSER_AUTOMATION
    try {
      const result = await automateSingleSource(db, {
        profileId: 'p-A',
        userId: 'u-A',
        source: { opportunity_id: 'opp-portal', current_stage: 'gathering_documents' },
      })
      assert.equal(result.task.automation_type, 'portal')
      assert.equal(result.task.status, 'ready_to_start')
      assert.equal(result.task.portal_url, 'https://example.com/apply')
    } finally {
      if (prev !== undefined) process.env.YANA_ENABLE_BROWSER_AUTOMATION = prev
    }
  })

  it('marks unknown sources as blocked with a clear note (does not fabricate)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description) VALUES ('opp-?', 'No info', 'Nothing actionable')`).run()
    const result = await automateSingleSource(db, {
      profileId: 'p-A',
      userId: 'u-A',
      source: { opportunity_id: 'opp-?', current_stage: 'discovered' },
    })
    assert.equal(result.classification.automation_type, 'unknown')
    assert.equal(result.task.status, 'blocked')
    assert.ok(result.task.last_agent_message?.toLowerCase().includes('could not determine'))
  })

  it('does NOT block based on selected pipeline stage — accepts every stage from discovered through awarded', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, mailing_address, application_mode, funder_name)
                    VALUES ('opp-anytime', 'Stage-agnostic award', '1 Main', 'mail', 'F')`).run()
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

  it('keeps tasks scoped to the profile (no cross-profile leak)', async () => {
    resetCaches()
    const db = makeMemoryDb()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, mailing_address, application_mode, funder_name)
                    VALUES ('opp-pm', 'X', '1', 'mail', 'F')`).run()
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
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, mailing_address, application_mode, funder_name)
                    VALUES ('opp-audit', 'Award', '1', 'mail', 'F')`).run()
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
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, application_url, application_mode, funder_name)
                    VALUES ('o-portal', 'P', 'https://x/apply', 'portal', 'F')`).run()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, mailing_address, application_mode, funder_name)
                    VALUES ('o-mail', 'M', '1', 'mail', 'F')`).run()
    db.raw.prepare(`INSERT INTO funding_opportunities (id, title, description, result_kind, funder_name)
                    VALUES ('o-dir', 'D', 'directory', 'directory', 'F')`).run()
    delete process.env.YANA_ENABLE_BROWSER_AUTOMATION
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
    assert.equal(result.results[2].task.automation_type, 'no_application')
    // Each source produced its own task row.
    const tasks = await listApplicationTasks(db, { profileId: 'p-A' })
    assert.equal(tasks.length, 3)
    // Re-fetching each task by id returns the persisted shape.
    for (const r of result.results) {
      const fresh = await getApplicationTask(db, r.task.id)
      assert.equal(fresh.id, r.task.id)
      assert.ok(fresh.automation_type)
    }
  })
})
