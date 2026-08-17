import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('pdf-parse', () => ({
  default: vi.fn(async (buffer) => ({ text: buffer.toString('utf8') })),
}))
vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(async ({ buffer }) => ({ value: buffer.toString('utf8') })),
  },
}))

import {
  chunkSolicitationText,
  extractSolicitationText,
  ingestSolicitationVersion,
  normalizeModelRequirementCandidates,
} from '../services/solicitationRequirements.js'
import {
  auditDraftAgainstStoredRequirements,
  buildGroundedDraftCoverage,
  detectHighRiskApplicantClaims,
  loadAvailableApplicationDocuments,
  persistDraftRequirementCoverage,
} from '../services/groundedDrafting.js'
import {
  linkApplicationLifecycle,
  loadApplicationLifecycle,
  recordApplicationOutcomeEvidence,
  revokeApplicationOutcomeEvidence,
} from '../services/applicationLifecycleReadModel.js'
import { createApplicationFromOpportunity, wireApplicationLifecycleRequirements } from '../services/applicationWorkflow.js'

const here = dirname(fileURLToPath(import.meta.url))
const sqliteMigrationPath = resolve(here, '../db/migrations/171_solicitation_requirements_lifecycle.sql')
const postgresMigrationPath = resolve(here, '../db/postgres/migrations/0176_solicitation_requirements_lifecycle.sql')
const lifecyclePagePath = resolve(here, '../../src/pages/GrantLifecycle.jsx')
const lifecycleApiPath = resolve(here, '../../src/api/grantLifecycle.js')

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, deadline TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT,
      title TEXT, status TEXT, updated_at DATETIME
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, grant_id TEXT, name TEXT,
      type TEXT, mime_type TEXT, file_size INTEGER, file_bytes BLOB,
      extracted_text TEXT, content_hash TEXT, status TEXT, version INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT,
      pipeline_grant_id TEXT, user_id TEXT, status TEXT, grant_name TEXT,
      funder_name TEXT, deadline_date DATETIME, response_received_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT,
      grant_id TEXT, status TEXT, submitted_at DATETIME,
      output_document_id TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_drafts (
      id TEXT PRIMARY KEY, grant_id TEXT, section_name TEXT, section_order INTEGER,
      content TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_steps (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, step_order INTEGER,
      title TEXT, description TEXT, status TEXT, due_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_documents (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, filename TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE deadline_events (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, event_type TEXT,
      due_at DATETIME, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE submission_events (
      id TEXT PRIMARY KEY, application_id TEXT NOT NULL, event_type TEXT,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP, notes TEXT, outcome TEXT
    );
  `)
  db.exec(readFileSync(sqliteMigrationPath, 'utf8'))
  db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('profile-1', 'Evidence Org')
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
    .run('profile-1', 'programs_services', JSON.stringify({ impact: 'We served 1,200 students last year.' }))
  db.prepare('INSERT INTO funding_opportunities (id, title, sponsor, deadline) VALUES (?, ?, ?, ?)')
    .run('opp-1', 'Community Learning RFP', 'Example Foundation', '2027-03-15T17:00:00.000Z')
  db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('grant-1', 'profile-1', 'opp-1', 'Community Learning RFP', 'drafting', new Date().toISOString())
  db.prepare(
    `INSERT INTO grant_applications
      (id, profile_id, opportunity_id, pipeline_grant_id, user_id, status, grant_name, funder_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('app-1', 'profile-1', 'opp-1', 'grant-1', 'user-1', 'draft', 'Community Learning RFP', 'Example Foundation')
  return db
}

function citationFor(text, quote, chunks) {
  const charStart = text.indexOf(quote)
  if (charStart < 0) throw new Error(`quote missing in fixture: ${quote}`)
  const charEnd = charStart + quote.length
  const chunk = chunks.find((row) => charStart >= row.char_start && charEnd <= row.char_end)
  if (!chunk) throw new Error('fixture citation did not fit one chunk')
  return {
    chunk_index: chunk.chunk_index,
    quote_text: quote,
    char_start: charStart,
    char_end: charEnd,
    page_number: null,
  }
}

function requirementsFor(text) {
  const chunks = chunkSolicitationText(text)
  const eligibility = 'Applicants must be Tennessee nonprofit organizations with current charitable registration.'
  const deadline = 'Applications must be submitted by March 15, 2027 at 5:00 PM Eastern.'
  return [
    {
      canonical_key: 'eligibility:tennessee-nonprofit',
      requirement_type: 'eligibility',
      title: 'Eligible applicants',
      requirement_text: eligibility,
      normalized_value: { applicant_type: 'nonprofit', state: 'TN' },
      mandatory: true,
      confidence: 1,
      citations: [citationFor(text, eligibility, chunks)],
    },
    {
      canonical_key: 'deadline:application',
      requirement_type: 'deadline',
      title: 'Application deadline',
      requirement_text: deadline,
      normalized_value: { due_at: '2027-03-15T17:00:00.000Z' },
      mandatory: true,
      confidence: 1,
      citations: [citationFor(text, deadline, chunks)],
    },
  ]
}

let db
afterEach(() => {
  db?.close()
  db = null
})

describe('slice 7 — durable, complete solicitation ingestion', () => {
  it('extracts PDF and DOCX buffers without clipping and chunks every character', async () => {
    const content = `Opening\n${'complete source paragraph '.repeat(1_900)}\nClosing requirement.`
    const pdf = await extractSolicitationText({
      buffer: Buffer.from(content),
      mimeType: 'application/pdf',
      fileName: 'notice.pdf',
    })
    const docx = await extractSolicitationText({
      buffer: Buffer.from(content),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'notice.docx',
    })
    expect(pdf.text).toBe(content)
    expect(docx.text).toBe(content)
    const chunks = chunkSolicitationText(pdf.text)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks[0].char_start).toBe(0)
    expect(chunks.at(-1).char_end).toBe(content.length)
    for (let position = 0; position < content.length; position += 997) {
      expect(chunks.some((chunk) => position >= chunk.char_start && position < chunk.char_end)).toBe(true)
    }
  })

  it('derives model requirement citations from verbatim source quotes and rejects invented quotes', () => {
    const text = 'Narrative section. The project description must not exceed 500 words.'
    const chunks = chunkSolicitationText(text)
    const candidate = {
      chunk_index: 0,
      requirement_type: 'format',
      requirement_text: 'Project descriptions have a 500-word limit.',
      source_quote: 'The project description must not exceed 500 words.',
      normalized_value: { max_words: 500 },
      mandatory: true,
      confidence: 0.95,
    }
    const normalized = normalizeModelRequirementCandidates(chunks, [candidate])
    expect(normalized).toHaveLength(1)
    expect(normalized[0]).toMatchObject({
      requirement_type: 'format',
      normalized_value: { max_words: 500 },
      citations: [expect.objectContaining({
        quote_text: candidate.source_quote,
        char_start: text.indexOf(candidate.source_quote),
      })],
    })
    expect(() => normalizeModelRequirementCandidates(chunks, [{
      ...candidate,
      source_quote: 'The model invented this requirement.',
    }])).toThrow(/not found verbatim/)
  })

  it('persists immutable versions, citations, and amendment diffs', async () => {
    db = makeDb()
    const baseText = [
      'COMMUNITY LEARNING REQUEST FOR PROPOSALS',
      'Background information. '.repeat(900),
      'Applicants must be Tennessee nonprofit organizations with current charitable registration.',
      'Applications must be submitted by March 15, 2027 at 5:00 PM Eastern.',
    ].join('\n')
    const first = await ingestSolicitationVersion(db, {
      profile_id: 'profile-1', opportunity_id: 'opp-1', source_kind: 'rfp',
      source_url: 'https://example.org/rfp', title: 'Community Learning RFP',
      source_filename: 'rfp.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      text: baseText, requirements: requirementsFor(baseText), created_by_user_id: 'user-1',
    })
    expect(first.extracted_chars).toBe(baseText.length)
    expect(first.chunk_count).toBeGreaterThan(1)
    expect(first.requirement_count).toBe(2)

    const storedChunks = db.prepare(
      'SELECT * FROM solicitation_chunks WHERE version_id = ? ORDER BY chunk_index',
    ).all(first.version_id)
    expect(storedChunks[0].char_start).toBe(0)
    expect(storedChunks.at(-1).char_end).toBe(baseText.length)
    const citationCount = db.prepare(
      `SELECT COUNT(*) AS n FROM requirement_citations c
        JOIN solicitation_requirements r ON r.id = c.requirement_id
       WHERE r.version_id = ?`,
    ).get(first.version_id).n
    expect(citationCount).toBe(2)

    const changedEligibility = 'Applicants must be Tennessee nonprofit organizations with three years of charitable registration.'
    const addedDocument = 'Applicants must attach the most recent independently audited financial statements.'
    const deadline = 'Applications must be submitted by March 15, 2027 at 5:00 PM Eastern.'
    const amendedText = [
      'AMENDMENT 1', 'Background information. '.repeat(900), changedEligibility,
      deadline, addedDocument,
    ].join('\n')
    const chunks = chunkSolicitationText(amendedText)
    const amendedRequirements = [
      {
        canonical_key: 'eligibility:tennessee-nonprofit', requirement_type: 'eligibility',
        title: 'Eligible applicants', requirement_text: changedEligibility,
        normalized_value: { applicant_type: 'nonprofit', state: 'TN', years: 3 },
        mandatory: true, confidence: 1, citations: [citationFor(amendedText, changedEligibility, chunks)],
      },
      {
        canonical_key: 'deadline:application', requirement_type: 'deadline',
        title: 'Application deadline', requirement_text: deadline,
        normalized_value: { due_at: '2027-03-15T17:00:00.000Z' }, mandatory: true,
        confidence: 1, citations: [citationFor(amendedText, deadline, chunks)],
      },
      {
        canonical_key: 'document:audited-financials', requirement_type: 'document',
        title: 'Audited financial statements', requirement_text: addedDocument,
        normalized_value: { document: 'audited_financial_statements' }, mandatory: true,
        confidence: 1, citations: [citationFor(amendedText, addedDocument, chunks)],
      },
    ]
    const second = await ingestSolicitationVersion(db, {
      profile_id: 'profile-1', opportunity_id: 'opp-1', solicitation_id: first.solicitation_id,
      source_kind: 'amendment', source_url: 'https://example.org/rfp-amendment-1',
      title: 'Community Learning RFP — Amendment 1', text: amendedText,
      source_filename: 'amendment-1.pdf', mime_type: 'application/pdf', is_amendment: true,
      requirements: amendedRequirements, created_by_user_id: 'user-1',
    })
    expect(second.version_number).toBe(2)
    expect(second.amendment_changes.map((row) => row.change_type)).toEqual(
      expect.arrayContaining(['modified', 'added']),
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM solicitation_versions').get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM solicitation_amendment_diffs WHERE to_version_id = ?').get(second.version_id).n).toBe(2)
  })

  it('rejects a citation whose quote does not match the source range', async () => {
    db = makeDb()
    const text = 'Applicants must submit a budget.'
    await expect(ingestSolicitationVersion(db, {
      profile_id: 'profile-1', opportunity_id: 'opp-1', source_kind: 'rfp', text,
      requirements: [{
        canonical_key: 'budget:required', requirement_type: 'budget',
        requirement_text: text, mandatory: true, confidence: 1,
        citations: [{ chunk_index: 0, quote_text: 'Invented quote', char_start: 0, char_end: text.length }],
      }],
    })).rejects.toMatchObject({ code: 'SOLICITATION_CITATION_MISMATCH' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM solicitation_versions').get().n).toBe(0)
  })
})

describe('slice 8 — grounded drafting requirement/claim matrix', () => {
  it('fails closed when no validated solicitation requirements are linked', () => {
    const audit = buildGroundedDraftCoverage({ draftText: 'A draft without an authoritative solicitation.' })
    expect(audit.can_finalize).toBe(false)
    expect(audit.blockers).toContainEqual(expect.objectContaining({ code: 'SOLICITATION_REQUIREMENTS_REQUIRED' }))
  })

  it('requires applicant evidence to match the exact stored source id', () => {
    const draftText = 'We served 1,200 students last year.'
    const base = {
      draftText,
      requirements: [{
        id: 'req-1', canonical_key: 'narrative:impact', requirement_type: 'narrative',
        requirement_text: 'Describe impact.', mandatory: true, status: 'active', normalized_value: {},
      }],
      requirementResponses: [{
        requirement_id: 'req-1', response_excerpt: draftText, status: 'addressed', applicant_evidence: [],
      }],
      applicantNames: ['Evidence Org'],
      profileEvidenceSources: [{
        source_type: 'profile_section', source_id: 'profile-1:programs_services',
        value: { impact: draftText },
      }],
    }
    const wrongSource = buildGroundedDraftCoverage({
      ...base,
      claimEvidence: [{
        claim: draftText,
        evidence: [{ source_type: 'profile', source_id: 'profile-1', quote_text: draftText }],
      }],
    })
    expect(wrongSource.can_finalize).toBe(false)
    expect(wrongSource.unsupported_claims).toContainEqual(expect.objectContaining({
      claim: draftText,
      reason: 'evidence_quote_not_found_in_profile',
    }))

    const exactSource = buildGroundedDraftCoverage({
      ...base,
      claimEvidence: [{
        claim: draftText,
        evidence: [{
          source_type: 'profile_section', source_id: 'profile-1:programs_services', quote_text: draftText,
        }],
      }],
    })
    expect(exactSource.can_finalize).toBe(true)
  })

  it('does not count filename-only checklist rows as required-document proof', async () => {
    db = makeDb()
    db.prepare('INSERT INTO application_documents (id, application_id, filename) VALUES (?, ?, ?)')
      .run('checklist-only', 'app-1', 'audited financial statements.pdf')
    const application = {
      id: 'app-1', profile_id: 'profile-1', resolved_pipeline_grant_id: 'grant-1',
    }
    expect(await loadAvailableApplicationDocuments(db, application)).toEqual([])

    const bytes = Buffer.from('verified audited financial statements')
    const hash = createHash('sha256').update(bytes).digest('hex')
    db.prepare(
      `INSERT INTO documents
        (id, profile_id, grant_id, name, type, mime_type, file_bytes, content_hash, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'durable-audit', 'profile-1', 'grant-1', 'audited financial statements.pdf',
      'financial_statement', 'application/pdf', bytes, hash, 'final', 1,
    )
    expect(await loadAvailableApplicationDocuments(db, application))
      .toContainEqual(expect.objectContaining({ id: 'durable-audit', content_hash: hash }))
  })

  it('enforces normalized limits, questions, required documents, and budget/match values', () => {
    const narrative = 'Our complete response contains seven words for this question.'
    const budget = 'The project budget is $50,000.'
    const audit = buildGroundedDraftCoverage({
      draftText: `${narrative} ${budget}`,
      requirements: [
        {
          id: 'req-question', canonical_key: 'question:need', requirement_type: 'narrative',
          requirement_text: 'Answer the need question in five words on one page.', mandatory: true,
          status: 'active', normalized_value: { question: 'What need will be addressed?', max_words: 5, max_pages: 1 },
        },
        {
          id: 'req-doc', canonical_key: 'document:audit', requirement_type: 'document',
          requirement_text: 'Attach audited financial statements.', mandatory: true,
          status: 'active', normalized_value: { required_documents: ['audited financial statements'] },
        },
        {
          id: 'req-budget', canonical_key: 'budget:match', requirement_type: 'budget',
          requirement_text: 'Use a $50,000 budget and 20 percent match.', mandatory: true,
          status: 'active', normalized_value: { budget_amount: 50_000, match_percentage: 20 },
        },
      ],
      requirementResponses: [
        {
          requirement_id: 'req-question', response_excerpt: narrative,
          response_text: narrative, page_count: 2, status: 'addressed', applicant_evidence: [],
        },
        {
          requirement_id: 'req-budget', response_excerpt: budget,
          response_text: budget, status: 'addressed', applicant_evidence: [],
        },
      ],
      availableDocuments: [],
    })
    expect(audit.can_finalize).toBe(false)
    const violations = audit.blockers
      .filter((row) => row.code === 'REQUIREMENT_CONSTRAINT_VIOLATION')
      .flatMap((row) => row.violations)
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/^max_words_exceeded:/),
      expect.stringMatching(/^max_pages_exceeded:/),
      'required_document_missing:audited financial statements',
      'match_percentage_not_addressed:20',
    ]))
  })

  it('grounds third-person applicant history but excludes future targets from fact claims', () => {
    const claims = detectHighRiskApplicantClaims(
      'Evidence Org served 1,200 students last year. Evidence Org will serve 2,000 students next year.',
      { applicantNames: ['Evidence Org'] },
    )
    expect(claims).toEqual(['Evidence Org served 1,200 students last year.'])
  })

  it('blocks unsupported claims, then persists a fully grounded matrix', async () => {
    db = makeDb()
    const text = [
      'Applicants must be Tennessee nonprofit organizations with current charitable registration.',
      'Applications must be submitted by March 15, 2027 at 5:00 PM Eastern.',
    ].join('\n')
    await ingestSolicitationVersion(db, {
      profile_id: 'profile-1', opportunity_id: 'opp-1', source_kind: 'rfp', text,
      source_url: 'https://example.org/rfp', requirements: requirementsFor(text),
    })
    await wireApplicationLifecycleRequirements(db, 'app-1')
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_steps WHERE description LIKE '%[solicitation-requirement:%'").get().n).toBe(2)
    expect(db.prepare("SELECT COUNT(*) AS n FROM deadline_events WHERE event_type = 'solicitation_deadline'").get().n).toBe(1)

    const draftText = [
      'We are a Tennessee nonprofit organization with current charitable registration.',
      'We served 1,200 students last year.',
      'The completed application will be submitted by March 15, 2027 at 5:00 PM Eastern.',
    ].join(' ')
    const storedRequirements = db.prepare('SELECT id, canonical_key FROM solicitation_requirements').all()
    const byKey = new Map(storedRequirements.map((row) => [row.canonical_key, row.id]))
    const responses = [
      {
        requirement_id: byKey.get('eligibility:tennessee-nonprofit'),
        response_excerpt: 'We are a Tennessee nonprofit organization with current charitable registration.',
        status: 'addressed', applicant_evidence: [],
      },
      {
        requirement_id: byKey.get('deadline:application'),
        response_excerpt: 'The completed application will be submitted by March 15, 2027 at 5:00 PM Eastern.',
        status: 'addressed', applicant_evidence: [],
      },
    ]
    const blocked = await auditDraftAgainstStoredRequirements(db, {
      applicationId: 'app-1', draftText, requirementResponses: responses, claimEvidence: [],
    })
    expect(blocked.audit.can_finalize).toBe(false)
    expect(blocked.audit.blockers).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_APPLICANT_CLAIM' }))

    const grounded = await auditDraftAgainstStoredRequirements(db, {
      applicationId: 'app-1',
      draftText,
      requirementResponses: responses,
      claimEvidence: [{
        claim: 'We served 1,200 students last year.',
        evidence: [{
          source_type: 'profile_section', source_id: 'profile-1:programs_services',
          quote_text: 'We served 1,200 students last year.',
        }],
      }],
    })
    expect(grounded.audit.can_finalize).toBe(true)
    expect(grounded.audit.summary.addressed).toBe(2)
    db.prepare('INSERT INTO application_drafts (id, grant_id, content, status) VALUES (?, ?, ?, ?)')
      .run('draft-1', 'grant-1', draftText, 'final')
    await persistDraftRequirementCoverage(db, {
      applicationId: 'app-1', draftId: 'draft-1', audit: grounded.audit,
    })
    expect(db.prepare("SELECT COUNT(*) AS n FROM draft_requirement_coverage WHERE coverage_status = 'addressed'").get().n).toBe(2)
  })
})

describe('slice 9 — truthful canonical lifecycle read model', () => {
  it('persists the exact-profile pipeline grant when a workflow starts from Grant Detail', async () => {
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('profile-2', 'Second Org')
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor, deadline) VALUES (?, ?, ?, ?)')
      .run('opp-2', 'Second Opportunity', 'Second Funder', '2027-04-01T17:00:00.000Z')
    db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('grant-2', 'profile-2', 'opp-2', 'Second Opportunity', 'drafting', new Date().toISOString())

    await expect(createApplicationFromOpportunity(db, {
      profileId: 'profile-1', userId: 'user-1', pipelineGrantId: 'grant-2',
      opportunity: { id: 'opp-2', title: 'Second Opportunity' },
    })).rejects.toMatchObject({ code: 'PIPELINE_GRANT_PROFILE_MISMATCH', status: 403 })
    await expect(createApplicationFromOpportunity(db, {
      profileId: 'profile-2', userId: 'user-2', pipelineGrantId: 'grant-2',
      opportunity: { id: 'opp-1', title: 'Wrong Opportunity' },
    })).rejects.toMatchObject({ code: 'PIPELINE_GRANT_OPPORTUNITY_MISMATCH', status: 409 })

    const created = await createApplicationFromOpportunity(db, {
      profileId: 'profile-2', userId: 'user-2', pipelineGrantId: 'grant-2',
      opportunity: { id: 'opp-2', title: 'Second Opportunity', sponsor: 'Second Funder' },
    })
    expect(created.created).toBe(true)
    expect(db.prepare('SELECT profile_id, opportunity_id, pipeline_grant_id FROM grant_applications WHERE id = ?').get(created.id))
      .toEqual({ profile_id: 'profile-2', opportunity_id: 'opp-2', pipeline_grant_id: 'grant-2' })
  })

  it('wires grounding, finalization, authenticated receipts, lifecycle linking, and outcome evidence into the real page', () => {
    const page = readFileSync(lifecyclePagePath, 'utf8')
    const api = readFileSync(lifecycleApiPath, 'utf8')
    for (const productionCall of [
      'auditGroundedDraft(',
      'finalizeLifecycleDraft(',
      'linkApplicationLifecycle(',
      'recordOutcomeEvidence(',
      'revokeOutcomeEvidence(',
      'downloadAuthenticatedUrl(',
    ]) {
      expect(page).toContain(productionCall)
    }
    expect(page).not.toMatch(/href=\{`\/api\/documents\/\$\{/)
    expect(api).toContain("method: 'PUT'")
    expect(api).toContain("status: 'final'")
  })

  it('rejects caller-supplied task and solicitation links outside the application subject', async () => {
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('profile-2', 'Other Org')
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor, deadline) VALUES (?, ?, ?, ?)')
      .run('opp-2', 'Other Opportunity', 'Other Funder', null)
    db.prepare(
      `INSERT INTO application_tasks (id, profile_id, opportunity_id, grant_id, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-cross-profile', 'profile-2', 'opp-1', null, 'draft')
    db.prepare(
      `INSERT INTO application_tasks (id, profile_id, opportunity_id, grant_id, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('task-cross-opportunity', 'profile-1', 'opp-2', null, 'draft')
    db.prepare(
      `INSERT INTO opportunity_solicitations
        (id, profile_id, opportunity_id, source_kind, source_url)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('sol-cross-profile', 'profile-2', 'opp-1', 'rfp', 'https://other.example/rfp')
    db.prepare(
      `INSERT INTO opportunity_solicitations
        (id, profile_id, opportunity_id, source_kind, source_url)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('sol-cross-opportunity', 'profile-1', 'opp-2', 'rfp', 'https://other.example/second')

    await expect(linkApplicationLifecycle(db, {
      applicationId: 'app-1', canonicalTaskId: 'task-cross-profile',
    })).rejects.toMatchObject({ code: 'CANONICAL_TASK_SCOPE_MISMATCH', status: 403 })
    await expect(linkApplicationLifecycle(db, {
      applicationId: 'app-1', canonicalTaskId: 'task-cross-opportunity',
    })).rejects.toMatchObject({ code: 'CANONICAL_TASK_SCOPE_MISMATCH', status: 403 })
    await expect(linkApplicationLifecycle(db, {
      applicationId: 'app-1', solicitationId: 'sol-cross-profile',
    })).rejects.toMatchObject({ code: 'SOLICITATION_SCOPE_MISMATCH', status: 403 })
    await expect(linkApplicationLifecycle(db, {
      applicationId: 'app-1', solicitationId: 'sol-cross-opportunity',
    })).rejects.toMatchObject({ code: 'SOLICITATION_SCOPE_MISMATCH', status: 403 })
  })

  it('rejects outcome evidence owned by another profile even when the grant id matches', async () => {
    db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('profile-2', 'Other Org')
    const bytes = Buffer.from('other tenant response notice')
    db.prepare(
      `INSERT INTO documents
        (id, profile_id, grant_id, name, type, mime_type, file_bytes, file_size, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cross-profile-doc', 'profile-2', 'grant-1', 'Response.pdf', 'award_notice',
      'application/pdf', bytes, bytes.length, 'final', 1,
    )
    await expect(recordApplicationOutcomeEvidence(db, {
      application_id: 'app-1', document_id: 'cross-profile-doc', outcome: 'awarded',
      response_received_at: '2027-06-01T14:00:00.000Z', attested_by_user_id: 'user-1',
    })).rejects.toMatchObject({ code: 'OUTCOME_DOCUMENT_SCOPE_MISMATCH', status: 403 })
  })

  it('keeps a raw outcome non-terminal until durable response evidence is linked', async () => {
    db = makeDb()
    db.prepare("UPDATE grant_applications SET status = 'awarded' WHERE id = 'app-1'").run()
    const unverified = await loadApplicationLifecycle(db, 'app-1')
    expect(unverified.state.current_state).toBe('outcome_recorded_unverified')
    expect(unverified.state.terminal).toBe(false)
    expect(unverified.outcome.verified).toBe(false)

    const receiptBytes = Buffer.from('official award notice bytes')
    db.prepare(
      `INSERT INTO documents
        (id, profile_id, grant_id, name, type, mime_type, file_bytes, file_size, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'award-doc-1', 'profile-1', 'grant-1', 'Award Notice.pdf', 'award_notice',
      'application/pdf', receiptBytes, receiptBytes.length, 'final', 1,
    )
    const recorded = await recordApplicationOutcomeEvidence(db, {
      application_id: 'app-1', document_id: 'award-doc-1', outcome: 'awarded',
      response_received_at: '2027-06-01T14:00:00.000Z',
      confirmation_reference: 'AWD-2027-41', attested_by_user_id: 'user-1',
    })
    expect(recorded.duplicate).toBe(false)

    const verified = await loadApplicationLifecycle(db, 'app-1')
    expect(verified.state.current_state).toBe('awarded_verified')
    expect(verified.state.terminal).toBe(true)
    expect(verified.state.terminal_state).toBe('awarded')
    expect(verified.outcome.verified).toBe(true)
    expect(verified.documents.durable_artifacts).toContainEqual(
      expect.objectContaining({ id: 'award-doc-1', bytes_retrievable: 1 }),
    )

    expect(() => db.prepare(
      'UPDATE application_outcome_evidence SET outcome = ? WHERE id = ?',
    ).run('declined', recorded.evidence.id)).toThrow(/append-only/)

    const revoked = await revokeApplicationOutcomeEvidence(db, {
      application_id: 'app-1', evidence_id: recorded.evidence.id,
      reason: 'Notice was rescinded by the funder.', revoked_by_user_id: 'user-1',
    })
    expect(revoked.evidence).toMatchObject({
      status: 'revoked', revocation_reason: 'Notice was rescinded by the funder.',
      revoked_by_user_id: 'user-1',
    })
    expect(db.prepare("SELECT status FROM grant_applications WHERE id = 'app-1'").get().status)
      .toBe('under_review')
    expect(db.prepare("SELECT status FROM grants WHERE id = 'grant-1'").get().status)
      .toBe('follow_up')
    expect(() => db.prepare(
      'UPDATE application_outcome_evidence SET revocation_reason = ? WHERE id = ?',
    ).run('Rewritten reason', recorded.evidence.id)).toThrow(/append-only/)
  })

  it('keeps a verified withdrawal out of the legacy pipeline archived state', async () => {
    db = makeDb()
    const receiptBytes = Buffer.from('signed applicant withdrawal acknowledgment')
    db.prepare(
      `INSERT INTO documents
        (id, profile_id, grant_id, name, type, mime_type, file_bytes, file_size, status, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'withdrawal-doc-1', 'profile-1', 'grant-1', 'Withdrawal Acknowledgment.pdf',
      'withdrawal_notice', 'application/pdf', receiptBytes, receiptBytes.length, 'final', 1,
    )

    await recordApplicationOutcomeEvidence(db, {
      application_id: 'app-1', document_id: 'withdrawal-doc-1', outcome: 'withdrawn',
      response_received_at: '2027-04-01T14:00:00.000Z',
      confirmation_reference: 'WD-2027-14', attested_by_user_id: 'user-1',
    })

    expect(db.prepare("SELECT status FROM grant_applications WHERE id = 'app-1'").get().status)
      .toBe('withdrawn')
    expect(db.prepare("SELECT status FROM grants WHERE id = 'grant-1'").get().status)
      .toBe('drafting')
    const lifecycle = await loadApplicationLifecycle(db, 'app-1')
    expect(lifecycle.state.current_state).toBe('withdrawn_verified')
    expect(lifecycle.state.terminal).toBe(true)
    expect(lifecycle.state.terminal_state).toBe('withdrawn')
  })

  it('ships additive SQLite/Postgres migration parity under the reserved IDs', () => {
    const sqlite = readFileSync(sqliteMigrationPath, 'utf8')
    const postgres = readFileSync(postgresMigrationPath, 'utf8')
    for (const table of [
      'opportunity_solicitations', 'solicitation_versions', 'solicitation_chunks',
      'solicitation_requirements', 'requirement_citations', 'solicitation_amendment_diffs',
      'application_lifecycle_subjects', 'draft_requirement_coverage', 'application_outcome_evidence',
    ]) {
      expect(sqlite).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
      expect(postgres).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(sqliteMigrationPath).toMatch(/171_solicitation_requirements_lifecycle\.sql$/)
    expect(postgresMigrationPath).toMatch(/0176_solicitation_requirements_lifecycle\.sql$/)
    expect(sqlite).toContain('BEFORE UPDATE ON application_outcome_evidence')
    expect(sqlite).toContain('only active-to-revoked is permitted')
    expect(postgres).toContain('BEFORE UPDATE OR DELETE ON application_outcome_evidence')
    expect(postgres).toContain('NEW.evidence_sha256 IS NOT DISTINCT FROM OLD.evidence_sha256')
  })
})
