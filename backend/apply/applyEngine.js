import crypto from 'crypto'
import JSZip from 'jszip'
import { writeApplicationArtifact } from './storageAdapter.js'
import { createOpenAIClient } from '../utils/openaiClient.js'
import { requiresMedicalNecessity, generateMedicalNecessityDocument, DOCUMENT_TYPES } from '../services/medicalNecessity.js'
import { assertAllowedKeySet, buildEqualityWhereClause, assertSafeIdentifier } from '../utils/safeSql.js'
import { getScopedOpportunityForApplication } from '../utils/scopedOpportunity.js'
import { opportunityKindOf } from '../../shared/opportunityFundability.js'
import { isNoPerAwardFigureKind } from '../config/opportunityKindClasses.js'
import { classifyAidType } from '../config/aidTypePreferences.js'
import { isIndividualLikeProfileType } from '../services/matchEngine.js'
import { safeParseArrayField } from '../services/profileHelpers.js'
import { createLogger } from '../utils/logger.js'

const applyLog = createLogger('applyEngine')

// System prompt used by the auto-populate flow. Hoisted to module top so the
// async section writer can read it regardless of where the literal sits in
// the file (the descriptive prompt body otherwise pushed it below first use).
const GRANT_WRITER_SYSTEM_PROMPT = `You are a seasoned grant writer with an MBA and 15+ years of experience securing federal, state, and foundation funding for individuals and organizations. You write at the highest professional standard.

RULES:
- Use the applicant's REAL profile data throughout — never use placeholders like [INSERT NAME] or generic text
- Ground every needs statement in real demographics, health, financial, and geographic data
- Write with authority, using data-driven language that is compelling but not clinical
- Structure content with clear paragraphs and professional formatting
- Be specific about amounts, dates, locations, and measurable outcomes
- Write as if this application must compete against hundreds of others — it must stand out
- Every section should demonstrate alignment between the applicant's needs and the funder's mission
- For submission instructions, provide exact URLs, addresses, fax numbers, and step-by-step guidance
- ANTI-FABRICATION: never invent dollar amounts, line items, deadlines, addresses, contacts, fax numbers, URLs, or program details that aren't in the user-provided context. If a fact isn't in context, write "not on file" or omit the line — do not guess.
- TAILOR TO THE FUNDER: name the funder and argue alignment with the SPECIFIC program facts in the GRANT DETAILS (program description, stated eligibility, focus areas, award range). Never produce boilerplate that could be sent to any funder unchanged. If the funder's mission or priorities are NOT stated in the context, write "[review: confirm funder priority]" where an alignment claim would go — do not invent priorities.
- ANTI-MISMATCH: if the application context indicates a non-discretionary process (FAFSA-driven institutional aid, automatic profile match, nomination-only, invitation-only, or "no application"), do NOT produce a budget justification, project narrative, or evaluation plan. Return a single short note that the section does not apply to this submission style.`

// Hardcoded allowlist of tables + acceptable composite unique key sets used by
// the apply engine. Any dynamic table/identifier interpolation in this file
// must be validated through this map. See backend/utils/safeSql.js.
const APPLY_ENGINE_TABLES = Object.freeze({
  applications: {
    table: 'applications',
    allowedUniqueKeys: [
      ['grant_id', 'organization_id'],
      ['id'],
    ],
  },
  application_sections: {
    table: 'application_sections',
    allowedUniqueKeys: [
      ['application_id', 'section_key'],
      ['id'],
    ],
  },
  application_checklist_items: {
    table: 'application_checklist_items',
    allowedUniqueKeys: [
      ['application_id', 'key'],
      ['id'],
    ],
  },
  application_artifacts: {
    table: 'application_artifacts',
    allowedUniqueKeys: [
      ['application_id', 'format'],
      ['id'],
    ],
  },
})

function assertApplyEngineTable(table) {
  const entry = APPLY_ENGINE_TABLES[table]
  if (!entry) {
    const error = new Error(`Unsafe apply engine table: ${table}`)
    error.status = 400
    throw error
  }
  return entry
}

function nowSqlLiteral(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

let ensuredApplySchema = false
let ensureApplySchemaPromise = null

async function ensureApplyEngineSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredApplySchema) return
  if (ensureApplySchemaPromise) return ensureApplySchemaPromise

  ensureApplySchemaPromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'

    const createApplications = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS applications (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','exported','submitted')),
            submission_method TEXT CHECK(submission_method IN ('portal','email','fax','mail','s2s','download')),
            submitted_at TIMESTAMPTZ,
            exported_at TIMESTAMPTZ,
            portal_url TEXT,
            snapshot_json TEXT,
            artifact_uri TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE(grant_id, organization_id)
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS applications (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','exported','submitted')),
            submission_method TEXT CHECK(submission_method IN ('portal','email','fax','mail','s2s','download')),
            submitted_at DATETIME,
            exported_at DATETIME,
            portal_url TEXT,
            snapshot_json TEXT,
            artifact_uri TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(grant_id, organization_id)
          );
        `

    const createSections = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS application_sections (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            section_key TEXT NOT NULL,
            title TEXT,
            content TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE(application_id, section_key)
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS application_sections (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            section_key TEXT NOT NULL,
            title TEXT,
            content TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(application_id, section_key)
          );
        `

    const createChecklist = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS application_checklist_items (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            label TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','blocked')),
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now(),
            UNIQUE(application_id, key)
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS application_checklist_items (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            label TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','blocked')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(application_id, key)
          );
        `

    const createArtifacts = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS application_artifacts (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            format TEXT NOT NULL CHECK(format IN ('docx','zip','pdf')),
            storage_path TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now()
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS application_artifacts (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            format TEXT NOT NULL CHECK(format IN ('docx','zip','pdf')),
            storage_path TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `

    try {
      await db.prepare(createApplications).run()
      await db.prepare(createSections).run()
      await db.prepare(createChecklist).run()
      await db.prepare(createArtifacts).run()

      // Indexes (best-effort; harmless if they already exist)
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_grant_id ON applications(grant_id);').run()
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_org_id ON applications(organization_id);').run()
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);').run()
      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_application_sections_application_id ON application_sections(application_id);')
        .run()
      await db
        .prepare(
          'CREATE INDEX IF NOT EXISTS idx_application_checklist_application_id ON application_checklist_items(application_id);',
        )
        .run()
      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_application_checklist_status ON application_checklist_items(status);')
        .run()
      await db
        .prepare('CREATE INDEX IF NOT EXISTS idx_application_artifacts_application_id ON application_artifacts(application_id);')
        .run()

      ensuredApplySchema = true
    } catch (error) {
      ensuredApplySchema = false
      throw error
    } finally {
      // Allow retry after failures; keep memory bounded after success.
      ensureApplySchemaPromise = null
    }
  })()

  return ensureApplySchemaPromise
}

function normalizeMethod(method) {
  const v = String(method || '').trim().toLowerCase()
  if (!v) return null
  const allowed = new Set(['portal', 'email', 'fax', 'mail', 's2s', 'download'])
  return allowed.has(v) ? v : null
}

function normalizeStatus(status) {
  const v = String(status || '').trim().toLowerCase()
  if (!v) return null
  const allowed = new Set(['draft', 'ready', 'exported', 'submitted'])
  return allowed.has(v) ? v : null
}

function normalizeChecklistStatus(status) {
  const v = String(status || '').trim().toLowerCase()
  if (!v) return 'pending'
  const allowed = new Set(['pending', 'done', 'blocked'])
  return allowed.has(v) ? v : 'pending'
}

function safeJsonStringify(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ _error: 'unstringifiable_snapshot' })
  }
}

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function buildDocxBuffer({ title, sections, checklist }) {
  const zip = new JSZip()

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
  )

  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
  )

  const makeParagraphs = (text) => {
    const lines = String(text ?? '').split(/\r?\n/)
    return lines
      .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
      .join('')
  }

  const docBodyParts = []
  docBodyParts.push(makeParagraphs(title || 'Application Package'))
  docBodyParts.push(`<w:p/>`)

  docBodyParts.push(makeParagraphs('Sections'))
  docBodyParts.push(`<w:p/>`)

  for (const s of sections || []) {
    const heading = String(s.title || s.section_key || 'Section')
    docBodyParts.push(makeParagraphs(`## ${heading}`))
    docBodyParts.push(makeParagraphs(String(s.content || '').trim() || '[empty]'))
    docBodyParts.push(`<w:p/>`)
  }

  docBodyParts.push(makeParagraphs('Checklist'))
  docBodyParts.push(`<w:p/>`)
  for (const item of checklist || []) {
    const line = `- [${String(item.status || 'pending')}] ${String(item.label || item.key || '')}`.trim()
    docBodyParts.push(makeParagraphs(line))
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${docBodyParts.join('')}
    <w:sectPr/>
  </w:body>
</w:document>`

  zip.folder('word')?.file('document.xml', documentXml)

  zip.folder('docProps')?.file(
    'core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title || 'Application Package')}</dc:title>
  <dc:creator>GrantFlow</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${xmlEscape(new Date().toISOString())}</dcterms:created>
</cp:coreProperties>`,
  )

  return zip.generateAsync({ type: 'nodebuffer' })
}

async function getApplicationOr404(db, applicationId) {
  await ensureApplyEngineSchema(db)
  const row = await db.prepare('SELECT * FROM applications WHERE id = ?').get(String(applicationId))
  if (!row) {
    const err = new Error('Application not found')
    err.status = 404
    throw err
  }
  return row
}

/**
 * Upsert into an apply-engine table using a hardcoded identifier allowlist.
 *
 * Identifier safety: both the table name and the column names used for the
 * WHERE clause must come from APPLY_ENGINE_TABLES. Values are always passed
 * as bind parameters; only identifiers are interpolated.
 *
 * @param {object} args
 * @param {object} args.db                        - DB facade (prepare/run/get)
 * @param {string} args.table                     - Table name (must be in allowlist)
 * @param {string[]} args.uniqueKeys              - Column names forming the uniqueness constraint
 * @param {Array} args.uniqueValues               - Values matching uniqueKeys, in the same order
 * @param {string} args.insertSql                 - INSERT SQL. First bind param must be the row id.
 * @param {Array} args.insertParams               - INSERT bind params after the generated id
 * @param {string} args.updateSql                 - UPDATE SQL. Last bind param must be the row id.
 * @param {Array} args.updateParams               - UPDATE bind params before the row id
 */
async function upsertByUniqueKey({
  db,
  table,
  uniqueKeys,
  uniqueValues,
  insertSql,
  insertParams,
  updateSql,
  updateParams,
}) {
  const tableEntry = assertApplyEngineTable(table)
  assertAllowedKeySet(uniqueKeys, tableEntry.allowedUniqueKeys, `${table} unique key set`)

  // Double-validate: tableEntry.table must also satisfy the global identifier
  // allowlist so any drift between APPLY_ENGINE_TABLES and safeSql's list is
  // caught at the throw site instead of leaking an injection surface.
  const safeSqlIdentifier = assertSafeIdentifier(tableEntry.table, 'table')
  const uniqueWhereSql = buildEqualityWhereClause(uniqueKeys)

  const existing = await db
    .prepare(`SELECT id FROM ${safeSqlIdentifier} WHERE ${uniqueWhereSql} LIMIT 1`)
    .get(...uniqueValues)

  if (existing?.id) {
    await db.prepare(updateSql).run(...updateParams, existing.id)
    const updated = await db.prepare(`SELECT * FROM ${safeSqlIdentifier} WHERE id = ?`).get(existing.id)
    return { row: updated, created: false, mode: 'updated' }
  }

  const id = crypto.randomUUID()
  await db.prepare(insertSql).run(id, ...insertParams)
  const createdRow = await db.prepare(`SELECT * FROM ${safeSqlIdentifier} WHERE id = ?`).get(id)
  return { row: createdRow, created: true, mode: 'created' }
}

export async function prepareApplication({ db, grantId, organizationId, userId }) {
  if (!grantId) throw new Error('grantId required')
  if (!organizationId) throw new Error('organizationId required')

  await ensureApplyEngineSchema(db)
  const existing = await db
    .prepare('SELECT * FROM applications WHERE grant_id = ? AND organization_id = ? LIMIT 1')
    .get(String(grantId), String(organizationId))

  if (existing) return existing

  const id = crypto.randomUUID()
  await db
    .prepare(
      `
        INSERT INTO applications (id, grant_id, organization_id, status, snapshot_json, created_at, updated_at)
        VALUES (?, ?, ?, 'draft', ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})
      `,
    )
    .run(id, String(grantId), String(organizationId), safeJsonStringify({ created_by: userId ?? null }))

  return await db.prepare('SELECT * FROM applications WHERE id = ?').get(id)
}

export async function getApplication({ db, applicationId }) {
  return getApplicationOr404(db, applicationId)
}

export async function patchApplication({ db, applicationId, patch = {} }) {
  const existing = await getApplicationOr404(db, applicationId)

  const nextStatus = normalizeStatus(patch.status) ?? null
  const portalUrl = patch.portal_url !== undefined ? (patch.portal_url ? String(patch.portal_url) : null) : undefined
  const snapshot = patch.snapshot_json !== undefined ? patch.snapshot_json : undefined

  const mergedSnapshot =
    snapshot === undefined
      ? undefined
      : (() => {
          let prev = null
          try {
            prev = existing.snapshot_json ? JSON.parse(existing.snapshot_json) : null
          } catch (parseErr) {
            console.warn(
              `[applyEngine.updateApplication] snapshot_json parse failed for application ${existing.id}; replacing instead of merging:`,
              parseErr?.message,
            )
            prev = null
          }
          const next = snapshot && typeof snapshot === 'object' ? snapshot : null
          if (!next) return safeJsonStringify(prev)
          if (!prev || typeof prev !== 'object') return safeJsonStringify(next)
          return safeJsonStringify({ ...prev, ...next })
        })()

  await db
    .prepare(
      `
        UPDATE applications
        SET updated_at = ${nowSqlLiteral(db)},
            status = COALESCE(?, status),
            portal_url = COALESCE(?, portal_url),
            snapshot_json = COALESCE(?, snapshot_json)
        WHERE id = ?
      `,
    )
    .run(nextStatus, portalUrl === undefined ? null : portalUrl, mergedSnapshot === undefined ? null : mergedSnapshot, String(applicationId))

  return await db.prepare('SELECT * FROM applications WHERE id = ?').get(String(applicationId))
}

export async function listSections({ db, applicationId }) {
  await getApplicationOr404(db, applicationId)
  const rows = await db
    .prepare(
      `
        SELECT *
        FROM application_sections
        WHERE application_id = ?
        ORDER BY section_key ASC
      `,
    )
    .all(String(applicationId))
  return rows || []
}

export async function upsertSection({ db, applicationId, sectionKey, title, content }) {
  if (!sectionKey) throw new Error('sectionKey required')
  await getApplicationOr404(db, applicationId)

  const key = String(sectionKey)
  // `=== null` is safe here because the outer ternary already handled
  // `undefined`. eqeqeq-clean.
  const t = title !== undefined ? (title === null ? null : String(title)) : null
  const c = content !== undefined ? (content === null ? null : String(content)) : null

  const result = await upsertByUniqueKey({
    db,
    table: 'application_sections',
    uniqueKeys: ['application_id', 'section_key'],
    uniqueValues: [String(applicationId), key],
    insertSql: `
      INSERT INTO application_sections (id, application_id, section_key, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})
    `,
    insertParams: [String(applicationId), key, t, c],
    updateSql: `
      UPDATE application_sections
      SET updated_at = ${nowSqlLiteral(db)},
          title = COALESCE(?, title),
          content = COALESCE(?, content)
      WHERE id = ?
    `,
    updateParams: [t, c],
  })

  return result.row
}

export async function listChecklist({ db, applicationId }) {
  await getApplicationOr404(db, applicationId)
  const rows = await db
    .prepare(
      `
        SELECT *
        FROM application_checklist_items
        WHERE application_id = ?
        ORDER BY key ASC
      `,
    )
    .all(String(applicationId))
  return rows || []
}

export async function setChecklistItem({ db, applicationId, key, label, status }) {
  if (!key) throw new Error('key required')
  await getApplicationOr404(db, applicationId)

  const k = String(key)
  const l = label !== undefined ? (label === null ? null : String(label)) : null
  const s = normalizeChecklistStatus(status)

  const result = await upsertByUniqueKey({
    db,
    table: 'application_checklist_items',
    uniqueKeys: ['application_id', 'key'],
    uniqueValues: [String(applicationId), k],
    insertSql: `
      INSERT INTO application_checklist_items (id, application_id, key, label, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)})
    `,
    insertParams: [String(applicationId), k, l, s],
    updateSql: `
      UPDATE application_checklist_items
      SET updated_at = ${nowSqlLiteral(db)},
          label = COALESCE(?, label),
          status = COALESCE(?, status)
      WHERE id = ?
    `,
    updateParams: [l, s],
  })

  return result.row
}

export async function validateApplication({ db, applicationId }) {
  const app = await getApplicationOr404(db, applicationId)
  const sections = await listSections({ db, applicationId })
  const checklist = await listChecklist({ db, applicationId })

  const missingChecklist = (checklist || [])
    .filter((i) => String(i.status || '').toLowerCase() !== 'done')
    .map((i) => ({
      key: i.key,
      label: i.label ?? null,
      status: i.status ?? 'pending',
    }))

  const emptySections = (sections || [])
    .filter((s) => !String(s.content || '').trim())
    .map((s) => ({
      section_key: s.section_key,
      title: s.title ?? null,
    }))

  const ready = missingChecklist.length === 0 && emptySections.length === 0 && (sections || []).length > 0

  if (ready && String(app.status || '').toLowerCase() === 'draft') {
    await db
      .prepare(`UPDATE applications SET status = 'ready', updated_at = ${nowSqlLiteral(db)} WHERE id = ?`)
      .run(String(applicationId))
  }

  return {
    ok: true,
    application_id: String(applicationId),
    ready,
    missing: {
      checklist: missingChecklist,
      empty_sections: emptySections,
      no_sections: (sections || []).length === 0,
    },
  }
}

export async function compileApplicationPackage({ db, applicationId }) {
  const app = await getApplicationOr404(db, applicationId)
  const grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(String(app.grant_id))
  const org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(String(app.organization_id))
  const sections = await listSections({ db, applicationId })
  const checklist = await listChecklist({ db, applicationId })

  return {
    ok: true,
    application: app,
    grant: grant ?? null,
    organization: org ?? null,
    sections,
    checklist,
    compiled_at: new Date().toISOString(),
  }
}

export async function exportApplicationPackage({ db, applicationId, format }) {
  const normalizedFormat = String(format || '').toLowerCase()
  if (normalizedFormat !== 'zip' && normalizedFormat !== 'docx') {
    const err = new Error('Unsupported format')
    err.status = 400
    throw err
  }

  const compiled = await compileApplicationPackage({ db, applicationId })

  const checklist = Array.isArray(compiled.checklist) ? compiled.checklist : []
  const sections = Array.isArray(compiled.sections) ? compiled.sections : []

  let buffer
  let extension
  let storedFormat

  if (normalizedFormat === 'docx') {
    buffer = await buildDocxBuffer({
      title: compiled?.grant?.title ? `Application Package: ${compiled.grant.title}` : 'Application Package',
      sections,
      checklist,
    })
    extension = 'docx'
    storedFormat = 'docx'
  } else {
    const zip = new JSZip()
    zip.file('compiled_application.json', JSON.stringify(compiled, null, 2))
    zip.file('checklist.json', JSON.stringify(checklist, null, 2))

    const sectionsMd = sections
      .map((s) => {
        const title = String(s.title || s.section_key || 'Section').trim() || 'Section'
        const body = String(s.content || '').trim()
        return `## ${title}\n\n${body || '_[empty]_'}\n`
      })
      .join('\n')
    zip.file('proposal_sections.md', sectionsMd || '_No sections_')

    const cover = sections.find((s) => String(s.section_key || '').toLowerCase() === 'cover_letter')
    if (cover) {
      zip.file('cover_letter.md', String(cover.content || '').trim() || '_[empty]_')
    }

    buffer = await zip.generateAsync({ type: 'nodebuffer' })
    extension = 'zip'
    storedFormat = 'zip'
  }

  const artifactId = crypto.randomUUID()

  const written = await writeApplicationArtifact({
    applicationId: String(applicationId),
    artifactId,
    extension,
    buffer,
  })

  await db
    .prepare(
      `
        INSERT INTO application_artifacts (id, application_id, format, storage_path, created_at)
        VALUES (?, ?, ?, ?, ${nowSqlLiteral(db)})
      `,
    )
    .run(artifactId, String(applicationId), storedFormat, written.storage_path)

  await db
    .prepare(
      `
        UPDATE applications
        SET status = 'exported',
            exported_at = ${nowSqlLiteral(db)},
            artifact_uri = ?,
            updated_at = ${nowSqlLiteral(db)}
        WHERE id = ?
      `,
    )
    .run(written.storage_path, String(applicationId))

  return {
    ok: true,
    artifact: {
      id: artifactId,
      application_id: String(applicationId),
      format: storedFormat,
      download_url: `/api/applications/${String(applicationId)}/artifacts/${artifactId}/download`,
    },
  }
}

export async function markSubmitted({ db, applicationId, method, metadata }) {
  const app = await getApplicationOr404(db, applicationId)
  const m = normalizeMethod(method)
  if (!m) {
    const err = new Error('Invalid submission method')
    err.status = 400
    throw err
  }

  // Non-fatal issues encountered during the submission side-effects. Surfaced
  // on the returned application row as `__submission_warnings` so callers (and
  // the UI / Anya) can tell the user what succeeded partially.
  const submissionWarnings = []

  // Merge snapshot for auditability.
  let prev = null
  try {
    prev = app.snapshot_json ? JSON.parse(app.snapshot_json) : null
  } catch (parseErr) {
    console.warn(
      `[applyEngine.markSubmitted] snapshot_json parse failed for application ${applicationId}; starting fresh submission snapshot:`,
      parseErr?.message,
    )
    prev = null
  }
  const nextSnapshot = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    submitted: {
      method: m,
      metadata: metadata ?? null,
      submitted_at: new Date().toISOString(),
    },
  }

  await db.withTransaction(async (tx) => {
    await tx
      .prepare(
        `
          UPDATE applications
          SET status = 'submitted',
              submission_method = ?,
              submitted_at = ${nowSqlLiteral(db)},
              snapshot_json = ?,
              updated_at = ${nowSqlLiteral(db)}
          WHERE id = ?
        `,
      )
      .run(m, safeJsonStringify(nextSnapshot), String(applicationId))

    // Keep grants pipeline consistent: mark the grant itself as submitted.
    // Failure here is non-fatal (the application was still recorded as
    // submitted) but MUST be visible so we can investigate pipeline drift.
    try {
      await tx
        .prepare(
          `
            UPDATE grants
            SET status = 'submitted',
                updated_at = ${nowSqlLiteral(db)}
            WHERE id = ?
              AND profile_id IN (SELECT profile_id FROM grants WHERE id = ?)
          `,
        )
        .run(String(app.grant_id), String(app.grant_id))
    } catch (err) {
      console.warn(
        `[applyEngine.markSubmitted] failed to mirror submitted status onto grants.id=${app.grant_id}:`,
        err?.message,
      )
      submissionWarnings.push({
        step: 'grants.status_mirror',
        grant_id: app.grant_id,
        error: err?.message,
      })
    }

    // Record a milestone for the submission event. Non-fatal but surfaced.
    try {
      const milestoneId = crypto.randomUUID()
      const dueDate = new Date().toISOString().slice(0, 10)
      await tx
        .prepare(
          `
            INSERT INTO milestones (id, grant_id, title, description, due_date, type, completed, completed_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          milestoneId,
          String(app.grant_id),
          'Submitted',
          `Submitted via ${m}`,
          dueDate,
          'submission',
          db?.dialect === 'postgres' ? true : 1,
          dueDate,
        )
    } catch (err) {
      console.warn(
        `[applyEngine.markSubmitted] failed to record submission milestone for grant_id=${app.grant_id}:`,
        err?.message,
      )
      submissionWarnings.push({
        step: 'milestone.insert',
        grant_id: app.grant_id,
        error: err?.message,
      })
    }
  })

  // Persist warnings onto the submission snapshot so Anya / admin UIs can
  // surface partial-failure context for past submissions, not just the
  // response of this request.
  if (submissionWarnings.length > 0) {
    try {
      const withWarnings = {
        ...nextSnapshot,
        submitted: {
          ...(nextSnapshot.submitted || {}),
          warnings: submissionWarnings,
        },
      }
      await db
        .prepare('UPDATE applications SET snapshot_json = ? WHERE id = ?')
        .run(safeJsonStringify(withWarnings), String(applicationId))
    } catch (persistErr) {
      console.warn(
        `[applyEngine.markSubmitted] failed to persist submission warnings to snapshot for application ${applicationId}:`,
        persistErr?.message,
      )
    }
  }

  const finalRow = await db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(String(applicationId))
  if (finalRow && submissionWarnings.length > 0) {
    finalRow.__submission_warnings = submissionWarnings
  }
  return finalRow
}

export async function autoPopulate({ db, applicationId }) {
  const app = await getApplicationOr404(db, applicationId)
  const grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(String(app.grant_id))

  const sources = []
  const sourceUrl = grant?.source_url ?? grant?.url ?? grant?.application_url ?? null
  if (sourceUrl) sources.push(String(sourceUrl))

  let portalUrl = null
  const maybePortal = grant?.application_method ?? null
  if (maybePortal && /^https?:\/\//i.test(String(maybePortal))) portalUrl = String(maybePortal)
  if (!portalUrl && sourceUrl && /^https?:\/\//i.test(String(sourceUrl))) portalUrl = String(sourceUrl)

  // Gather profile data for AI content generation
  const profileData = await gatherProfileForApplication(db, grant)
  // Scoped lookup: resolve opportunity *through* the application→grant chain
  // rather than trusting a raw opportunity id. If the chain is intact the
  // opportunity is returned; otherwise we continue without it so auto-populate
  // still works for free-form grants that were entered manually.
  const scoped = await getScopedOpportunityForApplication(db, applicationId)
  const opportunity = scoped.opportunity

  const medNecCheck = requiresMedicalNecessity(opportunity || {})

  // Classify the application style. Different opportunity types use radically
  // different submission processes — a FAFSA-driven university financial aid
  // award accepts no "Budget Justification", and an invitation-only program
  // accepts no application at all. Generating a 7-section grant proposal for
  // those is worse than generating nothing: it misleads the user and the AI
  // hallucinates dollar lines that the funder will never read. We branch on
  // the classifier so each style ships with the sections that actually map
  // 1:1 to what the user has to do in the real world.
  const applicationStyle = classifyApplicationStyle(grant, opportunity, profileData)
  const defaultSections = buildDefaultSectionsForStyle(applicationStyle, {
    medNecRequired: medNecCheck.required,
  })

  const defaultChecklist = [
    { key: 'confirm_deadline', label: `Confirm deadline${grant?.deadline ? ': ' + grant.deadline : ' and timezone'}`, status: 'pending' },
    { key: 'confirm_eligibility', label: 'Confirm eligibility requirements', status: 'pending' },
    { key: 'gather_required_docs', label: 'Gather required documents/attachments', status: 'pending' },
    { key: 'review_budget', label: 'Review budget and match requirements', status: 'pending' },
    { key: 'final_review', label: 'Final review and compliance check', status: 'pending' },
    { key: 'submit_application', label: buildSubmissionChecklistLabel(grant), status: 'pending' },
  ]

  // Generate AI content for each section using profile data
  const aiContent = await generateApplicationSections(db, grant, opportunity, profileData, defaultSections)

  await db.withTransaction(async () => {
    const patch = {
      snapshot_json: { auto_populate: { sources, portal_url_source: sources[0] ?? null, profile_used: Boolean(profileData) } },
    }
    if (portalUrl) patch.portal_url = portalUrl
    if (grant?.application_method) patch.submission_method = mapMethodToSubmission(grant.application_method)
    await patchApplication({ db, applicationId, patch })

    for (const s of defaultSections) {
      const content = aiContent[s.section_key] || ''
      await upsertSection({ db, applicationId, sectionKey: s.section_key, title: s.title, content })
    }
    for (const c of defaultChecklist) {
      await setChecklistItem({ db, applicationId, key: c.key, label: c.label, status: c.status })
    }
  })

  return {
    ok: true,
    portal_url: portalUrl,
    sources,
    sections_seeded: defaultSections.length,
    checklist_seeded: defaultChecklist.length,
    ai_populated: Object.keys(aiContent).filter(k => aiContent[k]).length,
    submission_method: grant?.application_method || null,
  }
}

function mapMethodToSubmission(method) {
  const map = { portal: 'portal', print_and_mail: 'mail', fax: 'fax', email_contact: 'email', phone_contact: null }
  return map[method] || method || null
}

// ---------------------------------------------------------------------------
// Declared-kind → application-style registry
// ---------------------------------------------------------------------------
// The section template used to be one-size-fits-all: every opportunity —
// including student scholarships (HOPE, AAFS) — got the 7-section
// ORGANIZATIONAL grant-proposal shape with a Budget Justification and an
// Evaluation Plan no scholarship committee will ever read. The registry below
// maps an opportunity row's own DECLARED kind (funding_opportunities.
// opportunity_kind — canonical crawler-os vocabulary like 'SCHOLARSHIP', see
// shared/opportunityFundability.js — or the declared opportunity_type column)
// to the application style whose sections actually match the real document.
//
// Registry rules (CLAUDE.md house pattern):
//   * keys are UPPER-cased; prod stores BOTH casings, so every lookup
//     normalizes first (the opportunityKindClasses.js precedent);
//   * only a DECLARED column value selects a style — a title word alone is
//     never a declaration (#937 one-shared-word class), and an undeclared
//     row keeps the 'standard' default (silence is not a denial);
//   * the explicit application_method still wins over a declared kind — it
//     describes the real-world submission process, which is more specific
//     than what kind of money this is.
export const DECLARED_KIND_APPLICATION_STYLES = Object.freeze({
  SCHOLARSHIP: 'scholarship',
})

/**
 * Resolve an application style from the opportunity row's DECLARED kind
 * columns only. Returns the mapped style, or null when the row declares
 * nothing (callers fall through to heuristics / the standard default).
 */
export function applicationStyleFromDeclaredKind(opportunity) {
  if (!opportunity) return null
  // opportunityKindOf reads opportunity_kind ?? kind, upper-cased — the same
  // canonical accessor shared/opportunityFundability.js consumers use.
  const kind = opportunityKindOf(opportunity)
  if (kind && DECLARED_KIND_APPLICATION_STYLES[kind]) {
    return DECLARED_KIND_APPLICATION_STYLES[kind]
  }
  const declaredType = String(opportunity.opportunity_type ?? '').trim().toUpperCase()
  if (declaredType && DECLARED_KIND_APPLICATION_STYLES[declaredType]) {
    return DECLARED_KIND_APPLICATION_STYLES[declaredType]
  }
  return null
}

// ---------------------------------------------------------------------------
// Application-style classifier
// ---------------------------------------------------------------------------
// The auto-populate engine used to ship the same 7 sections (cover letter,
// statement of need, narrative, budget justification, background, evaluation,
// submission) regardless of the opportunity. That produced confidently-wrong
// output for non-discretionary aid: the AI would invent a "$10,000 budget
// justification" for a FAFSA-driven university financial aid program that
// accepts neither budgets nor narratives. The classifier below maps every
// known submission shape to a *workable* set of sections; everything else
// falls back to the standard discretionary-grant proposal structure.
//
// Heuristics intentionally err on the side of "no fabricated narrative":
//   * an explicit application_method always wins;
//   * next, the opportunity row's own DECLARED kind (see
//     DECLARED_KIND_APPLICATION_STYLES below) — a row that says it is a
//     SCHOLARSHIP gets the scholarship document shape;
//   * an absent application_method triggers a funder/title scan for
//     university financial aid patterns (sponsor: "<X> University" /
//     "<X> College", title contains "financial aid" / "tuition" /
//     "scholarship" + university match) — those are FAFSA-driven by
//     default in the U.S. landscape;
//   * finally, an INDIVIDUAL-root profile applying to a non-pointer row whose
//     TITLE names a scholarship (existing aidTypePreferences.classifyAidType
//     classifier) gets the scholarship shape too — the HOPE/AAFS rows in prod
//     declare no scholarship kind, so declared-kind alone cannot reach them.
//
// Returns one of: 'auto_fafsa' | 'auto_profile' | 'nomination' |
// 'invitation' | 'no_application' | 'scholarship' | 'standard'.
//
// `profile` (optional, the applying profile row incl. primary_type) enables
// the second scholarship trigger: an INDIVIDUAL-root profile applying to an
// opportunity whose own TITLE names a scholarship (per the existing
// aidTypePreferences.classifyAidType classifier — never a new one-word
// matcher). Callers that pass no profile keep the exact prior behavior.
export function classifyApplicationStyle(grant, opportunity, profile = null) {
  const explicit = String(grant?.application_method || opportunity?.application_method || '')
    .trim()
    .toLowerCase()
  if (
    explicit === 'auto_fafsa' ||
    explicit === 'auto_profile' ||
    explicit === 'nomination' ||
    explicit === 'invitation' ||
    explicit === 'no_application'
  ) {
    return explicit
  }

  // The opportunity row's own DECLARED kind wins over every heuristic below.
  // A row that declares nothing falls through — silence is not a denial, and
  // a title WORD alone must never flip the document shape (the #937
  // one-shared-word class), so the only title-based arm is the profile-gated
  // one at the bottom, keyed on an EXISTING classifier.
  // ORG exception: a church/nonprofit applying against a scholarship-kind row
  // is FUNDING or administering scholarships, not writing a personal essay —
  // an org-root profile keeps the organizational proposal shape. A null/
  // unknown profile does not veto the row's own declared contract.
  const declaredStyle = applicationStyleFromDeclaredKind(opportunity)
  const applicantIsIndividual = profile
    ? isIndividualLikeProfileType(profile.primary_type ?? profile.applicant_type)
    : null
  if (declaredStyle === 'scholarship' && applicantIsIndividual === false) {
    // fall through to the heuristics / standard default below
  } else if (declaredStyle) {
    return declaredStyle
  }

  const sponsor = String(grant?.funder || opportunity?.sponsor || '').toLowerCase()
  const title = String(grant?.title || opportunity?.title || '').toLowerCase()
  const description = String(
    grant?.program_description || opportunity?.description || '',
  ).toLowerCase()
  const fundingSourceType = String(
    grant?.funding_source_type || opportunity?.funding_source_type || '',
  )
    .trim()
    .toLowerCase()

  // URL host signals: studentaid.gov, fafsa.gov, .edu/financial-aid, common
  // university aid portals (TSAC etc) — these all mean "the application is
  // FAFSA + a school portal, NOT a free-form grant narrative".
  const urlBlob = [
    grant?.application_url,
    grant?.source_url,
    grant?.evidence_url,
    opportunity?.application_url,
    opportunity?.source_url,
    opportunity?.evidence_url,
  ]
    .filter(Boolean)
    .map(u => String(u).toLowerCase())
    .join(' ')

  const urlLooksLikeStudentAid =
    /(^|\W)(studentaid\.gov|fafsa\.gov|fafsa\.ed\.gov)\b/.test(urlBlob) ||
    /\.(edu)\/[^ ]*(financial[-_]?aid|tuition|scholarship|aid)/.test(urlBlob)

  const looksLikeUniversity =
    fundingSourceType === 'university' ||
    /\b(university|college|institute of technology|community college|polytechnic|state college)\b/.test(sponsor) ||
    /\b(university|college)\b/.test(title) ||
    /\.(edu)\b/.test(urlBlob)
  const looksLikeStudentAidProgram =
    /\b(financial aid|tuition assistance|tuition support|student aid|need-based aid|institutional aid|grant-in-aid|federal student aid|fafsa|pell grant|seog|tsac|hope scholarship|hope grant)\b/.test(
      title,
    ) ||
    /\b(fafsa|federal student aid|institutional aid|need-based|complete the fafsa|pell grant)\b/.test(description) ||
    urlLooksLikeStudentAid

  if (looksLikeUniversity && looksLikeStudentAidProgram) {
    return 'auto_fafsa'
  }
  // Direct studentaid.gov / FAFSA-anchored opportunities (Pell, SEOG, TEACH, etc.)
  // are FAFSA-driven even when the "university" signal is missing.
  if (urlLooksLikeStudentAid && /\b(pell|seog|teach|federal|fafsa)\b/.test(`${title} ${description}`)) {
    return 'auto_fafsa'
  }

  // Second scholarship trigger: an INDIVIDUAL-root profile (student/senior/
  // veteran/family leaves roll up via the canonical profile-type registry)
  // applying to an opportunity whose own TITLE names a scholarship. Two
  // independent conditions, both required (the house two-condition pattern —
  // one shared word is never enough, #937):
  //   1. the applying profile is a person, not an org — resolved through
  //      matchEngine.isIndividualLikeProfileType, never a hand-typed list;
  //   2. the title classifies as 'scholarship' per the EXISTING
  //      aidTypePreferences.classifyAidType (title-only by design, #1092) —
  //      classifyAidType's 'grant'/'unknown' verdicts deliberately do NOT
  //      trigger this.
  // Guard: a declared POINTER/BENEFIT kind (directory, referral,
  // school_portal, past_award_intel, benefit — the opportunityKindClasses
  // registry) never gets an essay: a locator titled "...Scholarships" is a
  // pointer, not an award. A declared opportunity_type of 'grant' is NOT a
  // rebuttal — crawlers default that column to 'grant' when the source said
  // nothing (`opp.opportunity_type || 'grant'`), so it cannot veto what the
  // row's own title states.
  if (applicantIsIndividual === true) {
    const declaredKindRaw = opportunity?.opportunity_kind ?? opportunity?.kind ?? null
    const pointerOrBenefit = isNoPerAwardFigureKind(declaredKindRaw)
    const titleOnly = grant?.title || opportunity?.title || ''
    if (!pointerOrBenefit && titleOnly && classifyAidType({ title: titleOnly }) === 'scholarship') {
      return 'scholarship'
    }
  }

  return 'standard'
}

export function buildDefaultSectionsForStyle(style, opts = {}) {
  const medNec = Boolean(opts.medNecRequired)
  switch (style) {
    case 'auto_fafsa':
      // FAFSA-driven institutional aid. The user's job is to file FAFSA,
      // confirm the school received the SAR, and complete any school-
      // specific verification forms — NOT to write a budget justification
      // the financial aid office will never read.
      return [
        { section_key: 'fafsa_steps', title: 'FAFSA Steps' },
        { section_key: 'school_aid_office', title: 'School Aid Office Contact' },
        { section_key: 'document_checklist', title: 'Document Checklist' },
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
    case 'auto_profile':
      // Profile-based auto-match (e.g. some scholarships, certain federal
      // benefits). The user just verifies that the right profile data is
      // on file with the funder — there is no narrative to write.
      return [
        { section_key: 'auto_match_steps', title: 'Auto-Match Steps' },
        { section_key: 'profile_verification', title: 'Profile Verification' },
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
    case 'nomination':
      // Nomination-only programs accept no direct applications. The user
      // needs to identify a qualifying nominator.
      return [
        { section_key: 'nomination_path', title: 'Nomination Path' },
        { section_key: 'nominator_outreach', title: 'Nominator Outreach' },
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
    case 'invitation':
      return [
        { section_key: 'invitation_status', title: 'Invitation Status' },
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
    case 'no_application':
      return [{ section_key: 'no_application_required', title: 'No Application Required' }]
    case 'scholarship':
      // Student scholarship / student-aid application. The document a
      // scholarship committee reads is a personal essay + academic record +
      // financial need + activities — NOT an organizational proposal. No
      // Budget Justification, no Evaluation Plan, no Project Narrative.
      // 'organization_background' is reused as "Applicant Background": its
      // existing prompt already handles individuals.
      return [
        { section_key: 'personal_statement', title: 'Personal Statement / Essay' },
        { section_key: 'academic_background', title: 'Academic Background' },
        { section_key: 'financial_need_statement', title: 'Financial Need Statement' },
        { section_key: 'activities_leadership', title: 'Activities & Leadership' },
        { section_key: 'organization_background', title: 'Applicant Background' },
        ...(medNec ? [{ section_key: 'medical_necessity', title: 'Medical Necessity Documentation' }] : []),
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
    case 'standard':
    default:
      return [
        { section_key: 'cover_letter', title: 'Cover Letter' },
        { section_key: 'needs_statement', title: 'Statement of Need' },
        { section_key: 'project_narrative', title: 'Project Narrative' },
        { section_key: 'budget_justification', title: 'Budget Justification' },
        { section_key: 'organization_background', title: 'Applicant Background' },
        { section_key: 'evaluation_plan', title: 'Evaluation Plan' },
        ...(medNec ? [{ section_key: 'medical_necessity', title: 'Medical Necessity Documentation' }] : []),
        { section_key: 'submission_instructions', title: 'Submission Instructions' },
      ]
  }
}

const NON_LLM_SECTION_KEYS = new Set([
  'fafsa_steps',
  'school_aid_office',
  'document_checklist',
  'auto_match_steps',
  'profile_verification',
  'nomination_path',
  'nominator_outreach',
  'invitation_status',
  'no_application_required',
  'submission_instructions',
])

function buildSubmissionChecklistLabel(grant) {
  const method = grant?.application_method || ''
  if (method === 'print_and_mail' && grant?.funder_address) return `Print and mail to: ${grant.funder_address}`
  if (method === 'fax' && grant?.funder_fax) return `Fax completed application to: ${grant.funder_fax}`
  if (method === 'portal' && (grant?.application_url)) return `Submit via online portal: ${grant.application_url}`
  if (grant?.contact_email) return `Submit via email to: ${grant.contact_email}`
  return 'Submit completed application per funder instructions'
}

async function gatherProfileForApplication(db, grant) {
  if (!grant?.profile_id) return null
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(grant.profile_id)
  if (!profile) return null
  const sections = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(grant.profile_id)
  const parsed = {}
  for (const s of (sections || [])) {
    try {
      parsed[s.section_key] = typeof s.data === 'string' ? JSON.parse(s.data) : s.data
    } catch (parseErr) {
      console.warn(
        `[applyEngine.loadProfileWithSections] profile_sections.data parse failed for profile=${grant.profile_id} section=${s?.section_key}:`,
        parseErr?.message,
      )
    }
  }
  return { ...profile, sections: parsed }
}

// Per-section OpenAI call budget for the auto-populate path. Tight on purpose:
// the route is invoked from a button click and Railway/Vercel kill HTTP requests
// at ~60s, so a sequential loop of 7-8 calls @ default 30s each would 504 every
// time. We parallelize the calls (gpt-4o-mini RPM/TPM are far above this fan-out)
// and bound each call to AUTO_POPULATE_PER_SECTION_TIMEOUT_MS, with a hard
// wall-clock ceiling of AUTO_POPULATE_TOTAL_BUDGET_MS for the whole batch. Any
// section that doesn't return in time gets an empty string and we proceed —
// auto-populate is a "seed the draft" feature, never a hard-fail surface.
const AUTO_POPULATE_PER_SECTION_TIMEOUT_MS = Number(
  process.env.AUTO_POPULATE_PER_SECTION_TIMEOUT_MS || 25_000,
)
const AUTO_POPULATE_TOTAL_BUDGET_MS = Number(
  process.env.AUTO_POPULATE_TOTAL_BUDGET_MS || 45_000,
)

export async function generateApplicationSections(db, grant, opportunity, profile, sectionDefs, options = {}) {
  const result = {}
  let openai = options.openaiOverride ?? null
  if (!openai) {
    try {
      // Drop retries to 0 in the auto-populate fan-out. The SDK default is 2
      // retries × 30s timeout per attempt (= up to 90s per call), which alone
      // already breaches the proxy budget. A retry on the next button click is
      // strictly safer than a 504.
      openai = createOpenAIClient({
        allowMissing: true,
        timeoutMs: AUTO_POPULATE_PER_SECTION_TIMEOUT_MS,
        maxRetries: 0,
      }).openai
    } catch (openaiErr) {
      console.warn(
        '[applyEngine.generateApplicationSections] OpenAI client unavailable; falling back to template content:',
        openaiErr?.message,
      )
    }
  }
  if (!openai) {
    console.log('[autoPopulate] No OpenAI key; generating template-based content only')
    return generateTemplateSections(db, grant, opportunity, profile, sectionDefs)
  }

  const grantContext = buildGrantContext(grant, opportunity)
  const profileContext = buildProfileContext(profile)
  const startedAt = Date.now()
  const wallBudgetMs = Number(options.totalBudgetMs ?? AUTO_POPULATE_TOTAL_BUDGET_MS)
  const wallController = new AbortController()
  const wallTimer = setTimeout(() => wallController.abort(), wallBudgetMs)

  const tasks = sectionDefs.map(async (section) => {
    const sectionStartedAt = Date.now()
    // Deterministic factual-guidance sections (FAFSA steps, school aid
    // office contact, nomination path, submission instructions, etc.)
    // never go to the LLM. They are built directly from grant + profile
    // data so the user sees real next steps, not hallucinated prose.
    if (NON_LLM_SECTION_KEYS.has(section.section_key)) {
      try {
        const text = buildFactualGuidanceSection(section.section_key, grant, opportunity, profile)
        result[section.section_key] = text
        return {
          section_key: section.section_key,
          ok: true,
          duration_ms: Date.now() - sectionStartedAt,
          chars: text.length,
          source: 'deterministic',
        }
      } catch (err) {
        result[section.section_key] = ''
        applyLog.warn('[autoPopulate] deterministic section build failed', {
          section_key: section.section_key,
          error: err?.message,
        })
        return {
          section_key: section.section_key,
          ok: false,
          duration_ms: Date.now() - sectionStartedAt,
          reason: 'deterministic_error',
        }
      }
    }
    try {
      const prompt = buildSectionPrompt(section.section_key, section.title, grantContext, profileContext, grant)
      const completion = await openai.chat.completions.create(
        {
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: GRANT_WRITER_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 1200,
        },
        {
          signal: wallController.signal,
          timeout: AUTO_POPULATE_PER_SECTION_TIMEOUT_MS,
        },
      )
      const text = completion?.choices?.[0]?.message?.content?.trim() || ''
      result[section.section_key] = text
      return {
        section_key: section.section_key,
        ok: true,
        duration_ms: Date.now() - sectionStartedAt,
        chars: text.length,
      }
    } catch (err) {
      result[section.section_key] = ''
      const aborted =
        err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || /aborted|abort/i.test(String(err?.message || ''))
      const reason = aborted ? 'wall_clock_or_per_call_timeout' : 'provider_error'
      console.warn(
        `[autoPopulate] AI generation failed for ${section.section_key} (${reason}):`,
        err?.message || err,
      )
      return {
        section_key: section.section_key,
        ok: false,
        duration_ms: Date.now() - sectionStartedAt,
        reason,
      }
    }
  })

  const settled = await Promise.allSettled(tasks)
  clearTimeout(wallTimer)

  const summary = settled.map((s) => (s.status === 'fulfilled' ? s.value : { ok: false }))
  const okCount = summary.filter((s) => s.ok).length
  const totalMs = Date.now() - startedAt
  console.log(
    `[autoPopulate] AI fan-out complete: ${okCount}/${sectionDefs.length} sections in ${totalMs}ms (per-section ${AUTO_POPULATE_PER_SECTION_TIMEOUT_MS}ms, wall ${wallBudgetMs}ms)`,
  )

  return result
}

async function generateTemplateSections(db, grant, opportunity, profile, sectionDefs) {
  const result = {}
  const name = profile?.display_name || profile?.name || 'the applicant'
  const title = grant?.title || opportunity?.title || 'this funding opportunity'
  const funder = grant?.funder || opportunity?.sponsor || 'the funding organization'

  for (const s of sectionDefs) {
    if (NON_LLM_SECTION_KEYS.has(s.section_key)) {
      // Deterministic factual sections work the same whether or not the
      // OpenAI key is present — they don't need it.
      try {
        result[s.section_key] = buildFactualGuidanceSection(s.section_key, grant, opportunity, profile)
      } catch (err) {
        applyLog.warn('[autoPopulate] template factual section build failed', {
          section_key: s.section_key,
          error: err?.message,
        })
        result[s.section_key] = ''
      }
      continue
    }
    if (s.section_key === 'medical_necessity') {
      try {
        const medDoc = await generateMedicalNecessityDocument(db, grant?.profile_id, {
          opportunityId: opportunity?.id, grantId: grant?.id,
        })
        result[s.section_key] = medDoc?.content || '[Medical necessity documentation will be generated when health data is available in the profile.]'
      } catch (medErr) {
        console.warn(
          `[applyEngine.generateTemplateSections] medical necessity generation failed for profile=${grant?.profile_id}:`,
          medErr?.message,
        )
        result[s.section_key] = '[Medical necessity documentation requires health information in the profile. Please update the health_medical section.]'
      }
    } else if (s.section_key === 'cover_letter') {
      result[s.section_key] = `Dear ${funder} Review Committee,\n\nI am writing to express my interest in ${title}. ${name} meets the eligibility criteria for this opportunity and respectfully requests consideration for funding.\n\n[This section will be enhanced with AI when available. Please review and customize.]\n\nSincerely,\n${name}`
    } else if (s.section_key === 'budget_justification') {
      // Without an LLM key we still must not invent dollar lines. Emit a
      // neutral placeholder that prompts the user to fill it in instead of
      // shipping fabricated amounts.
      result[s.section_key] =
        `[Budget justification will be enhanced with AI when available. ` +
        `For now, list each requested line item with its amount and a one-sentence justification grounded in the funder's eligibility criteria.]`
    } else {
      result[s.section_key] = ''
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Deterministic, fact-only section builders
// ---------------------------------------------------------------------------
// These sections must NEVER call an LLM. Their job is to surface real next
// steps with real data so the user can act on them today. If a field isn't
// known, we say "not on file" — we do not hallucinate. Every line is
// traceable to either grant.* or profile.* data, satisfying mission goals
// #1 (no placeholders), #6 (real data), #9 (explainable / reliable).

function safeName(profile) {
  return profile?.display_name || profile?.name || 'the applicant'
}

function safeUniversityFromGrant(grant, opportunity) {
  return grant?.funder || opportunity?.sponsor || 'the funding organization'
}

function lineIfPresent(label, value) {
  if (!value && value !== 0) return null
  const str = String(value).trim()
  if (!str) return null
  return `- **${label}:** ${str}`
}

function buildFafsaSteps(grant, opportunity, profile) {
  const school = safeUniversityFromGrant(grant, opportunity)
  const name = safeName(profile)
  const lines = [
    `## Filing the FAFSA for ${school}`,
    ``,
    `${school} financial aid does **not** accept a custom application or budget justification. ` +
      `Funding is determined by the FAFSA (Free Application for Federal Student Aid) plus any ` +
      `${school}-specific verification forms. Below is what ${name} actually has to do, in order:`,
    ``,
    `1. **Create or sign in to a Federal Student Aid (FSA) account** at https://studentaid.gov.`,
    `2. **Complete the FAFSA** for the appropriate award year. List ${school} as a school to receive results.`,
    `3. **Watch for the Student Aid Report (SAR)** — it confirms FAFSA was processed.`,
    `4. **Check the ${school} financial aid portal** for any school-specific verification or scholarship forms.`,
    `5. **Respond to verification requests** within the deadline shown on the school portal — missing this step delays the award.`,
    `6. **Review the financial aid offer** the school issues; accept / decline each component (grants, work-study, loans).`,
  ]
  if (grant?.deadline) {
    lines.push(``, `**Posted deadline on file:** ${grant.deadline}`)
  }
  return lines.join('\n')
}

function buildSchoolAidOffice(grant, opportunity) {
  const school = safeUniversityFromGrant(grant, opportunity)
  const lines = [`## ${school} Financial Aid Office`, ``]
  const contactLines = [
    lineIfPresent('Address', grant?.funder_address),
    lineIfPresent('Email', grant?.funder_email || grant?.contact_email),
    lineIfPresent('Phone', grant?.funder_phone || grant?.contact_phone),
    lineIfPresent('Fax', grant?.funder_fax),
    lineIfPresent('Aid portal', grant?.application_url || grant?.url),
  ].filter(Boolean)
  if (contactLines.length === 0) {
    lines.push(
      `No verified contact information for the ${school} financial aid office is currently on file. ` +
        `Search "${school} financial aid contact" and confirm the listing on the official .edu domain ` +
        `before submitting any documents.`,
    )
  } else {
    lines.push(...contactLines)
  }
  return lines.join('\n')
}

function buildDocumentChecklist(grant, opportunity, profile) {
  const lines = [
    `## Document Checklist`,
    ``,
    `Have these ready before logging into the school's aid portal — most schools require them for FAFSA verification:`,
    ``,
    `- Most recent **federal tax return** (1040) for the household`,
    `- **W-2s and 1099s** for the same tax year`,
    `- **Social Security number** for the student${profile ? '' : ' (and dependent parent if applicable)'}`,
    `- **Driver's license / state ID**`,
    `- **High school transcript** or GED, plus any prior college transcripts`,
    `- **Selective Service registration** (males 18-25 born after 1959)`,
    `- **Records of untaxed income** (child support, veterans benefits, etc.)`,
  ]
  if (profile?.sections?.financial_information?.household_size) {
    lines.push(
      ``,
      `Household size on profile: **${profile.sections.financial_information.household_size}**. ` +
        `Make sure this matches what is reported on the FAFSA.`,
    )
  }
  return lines.join('\n')
}

function buildAutoMatchSteps(grant, opportunity, profile) {
  const program = grant?.title || opportunity?.title || 'this program'
  const funder = safeUniversityFromGrant(grant, opportunity)
  const name = safeName(profile)
  return [
    `## Auto-match Steps for ${program}`,
    ``,
    `${funder} matches ${name} to ${program} **automatically** based on profile data the funder ` +
      `already has on file. There is no narrative or budget to write. The user-side actions are:`,
    ``,
    `1. **Verify enrollment / eligibility status** is current with the funder.`,
    `2. **Confirm the contact information on file** (email + mailing address) so the funder can reach the recipient.`,
    `3. **Review the criteria** — if the profile changes (income, household size, enrollment), notify the funder so the match stays accurate.`,
    `4. **Watch the funder's portal / inbox** for the award notice. No further submission is required.`,
  ].join('\n')
}

function buildProfileVerification(grant, opportunity, profile) {
  if (!profile) {
    return `## Profile Verification\n\nNo applicant profile is currently linked to this application. Open the profile and confirm the eligibility-relevant fields are filled before continuing.`
  }
  const lines = [`## Profile Verification`, ``, `Confirm each of these fields matches what the funder expects:`, ``]
  const fields = [
    ['Display name', profile.display_name || profile.name],
    ['State', profile.state],
    ['Profile type', profile.primary_type],
    ['Household income', profile.sections?.financial_information?.annual_income],
    ['Household size', profile.sections?.financial_information?.household_size],
  ]
  for (const [label, value] of fields) {
    lines.push(`- **${label}:** ${value === undefined || value === null || value === '' ? 'not on file' : value}`)
  }
  return lines.join('\n')
}

function buildNominationPath(grant, opportunity) {
  const program = grant?.title || opportunity?.title || 'this opportunity'
  const funder = safeUniversityFromGrant(grant, opportunity)
  return [
    `## Nomination Path for ${program}`,
    ``,
    `${funder} accepts **nomination only** for ${program}. The applicant cannot self-submit; an eligible ` +
      `nominator (typically a teacher, employer, community leader, or program officer) must initiate the nomination.`,
    ``,
    `Action plan:`,
    `1. **Identify 2-3 potential nominators** who meet the funder's eligibility (read the funder page first).`,
    `2. **Draft a one-page bio + ask** the applicant can hand to a nominator.`,
    `3. **Reach out** with the bio + a clear deadline.`,
    `4. **Track replies** in the application checklist below.`,
  ].join('\n')
}

function buildNominatorOutreach(grant, opportunity, profile) {
  const program = grant?.title || opportunity?.title || 'this opportunity'
  const name = safeName(profile)
  return [
    `## Nominator Outreach Template`,
    ``,
    `Use this as a starting draft for the request — replace the brackets with specifics:`,
    ``,
    `> Dear [Nominator],`,
    `>`,
    `> I am applying to ${program} and the program accepts nominations only — applicants cannot self-submit.`,
    `> Would you be willing to write a brief nomination on my behalf? The funder's portal asks the nominator ` +
      `to confirm [eligibility criteria from the funder page] and submit by [deadline].`,
    `>`,
    `> Attached is a one-page summary of my background to make the nomination easier to write.`,
    `>`,
    `> Thank you for considering this — and either way, I appreciate your time.`,
    `>`,
    `> ${name}`,
  ].join('\n')
}

function buildInvitationStatus(grant, opportunity) {
  const program = grant?.title || opportunity?.title || 'this opportunity'
  return [
    `## Invitation Status for ${program}`,
    ``,
    `${program} is **invitation only**. There is no public application path. Do not submit any documents until ` +
      `an invitation is received directly from the funder.`,
    ``,
    `Recommended posture:`,
    `- **Do not contact the funder** to request an invitation unless a published path exists.`,
    `- **Track related funders** that share program officers / advisory boards — invitations often follow visibility in adjacent programs.`,
    `- **If contacted by the funder**, capture the invitation in this application immediately so the deadline tracker can fire.`,
  ].join('\n')
}

function buildNoApplicationRequired(grant, opportunity) {
  const program = grant?.title || opportunity?.title || 'this opportunity'
  return [
    `## No Application Required`,
    ``,
    `${program} **does not accept an application**. The funder either disburses the benefit automatically based ` +
      `on existing eligibility records, or the program is currently closed to new applicants. There is nothing for ` +
      `the user to submit.`,
    ``,
    `If the funder's website later reopens an application path, update the opportunity record's ` +
      `\`application_method\` field — the auto-populate engine will then ship the correct sections.`,
  ].join('\n')
}

function buildFactualGuidanceSection(sectionKey, grant, opportunity, profile) {
  switch (sectionKey) {
    case 'fafsa_steps':
      return buildFafsaSteps(grant, opportunity, profile)
    case 'school_aid_office':
      return buildSchoolAidOffice(grant, opportunity)
    case 'document_checklist':
      return buildDocumentChecklist(grant, opportunity, profile)
    case 'auto_match_steps':
      return buildAutoMatchSteps(grant, opportunity, profile)
    case 'profile_verification':
      return buildProfileVerification(grant, opportunity, profile)
    case 'nomination_path':
      return buildNominationPath(grant, opportunity)
    case 'nominator_outreach':
      return buildNominatorOutreach(grant, opportunity, profile)
    case 'invitation_status':
      return buildInvitationStatus(grant, opportunity)
    case 'no_application_required':
      return buildNoApplicationRequired(grant, opportunity)
    case 'submission_instructions':
      return buildSubmissionInstructions(grant, opportunity)
    default:
      return ''
  }
}

function buildSubmissionInstructions(grant, opportunity) {
  const parts = []
  const method = grant?.application_method || ''
  parts.push(`## How to Submit\n`)

  if (method === 'portal' || grant?.application_url) {
    parts.push(`**Method:** Online Portal Submission`)
    if (grant?.application_url) parts.push(`**Portal URL:** ${grant.application_url}`)
    parts.push(`\nVisit the portal URL above and follow the online instructions to complete your submission.`)
  } else if (method === 'print_and_mail') {
    parts.push(`**Method:** Print and Mail`)
    if (grant?.funder_address) parts.push(`**Mailing Address:**\n${grant.funder_address}`)
    parts.push(`\nPrint the completed application, sign where required, and mail to the address above.`)
  } else if (method === 'fax') {
    parts.push(`**Method:** Fax Submission`)
    if (grant?.funder_fax) parts.push(`**Fax Number:** ${grant.funder_fax}`)
    parts.push(`\nFax the completed and signed application to the number above.`)
  } else if (method === 'email_contact' || grant?.contact_email) {
    parts.push(`**Method:** Email Submission`)
    if (grant?.contact_email) parts.push(`**Email:** ${grant.contact_email}`)
    parts.push(`\nEmail the completed application as an attachment to the address above.`)
  }

  if (grant?.contact_name || grant?.contact_email || grant?.contact_phone) {
    parts.push(`\n## Contact Information`)
    if (grant?.contact_name) parts.push(`**Contact:** ${grant.contact_name}`)
    if (grant?.contact_email) parts.push(`**Email:** ${grant.contact_email}`)
    if (grant?.contact_phone) parts.push(`**Phone:** ${grant.contact_phone}`)
    if (grant?.funder_fax) parts.push(`**Fax:** ${grant.funder_fax}`)
    if (grant?.funder_address) parts.push(`**Address:** ${grant.funder_address}`)
  }

  if (grant?.deadline) parts.push(`\n## Deadline\n**Submission Deadline:** ${grant.deadline}`)

  return parts.join('\n') || 'No specific submission instructions available. Contact the funding organization for details.'
}

// Every fact here must come from the grant/opportunity ROW — this context is
// what makes a draft argue alignment with THIS funder's program instead of
// reading like boilerplate. Do not add derived/guessed facts: the prompts'
// anti-fabrication rules assume everything below was stated by the source.
function buildGrantContext(grant, opportunity) {
  const parts = []
  parts.push(`Grant/Opportunity: ${grant?.title || opportunity?.title || 'Unknown'}`)
  parts.push(`Funder: ${grant?.funder || opportunity?.sponsor || 'Unknown'}`)
  if (grant?.deadline || opportunity?.deadline) parts.push(`Deadline: ${grant?.deadline || opportunity.deadline}`)
  if (grant?.amount_requested || grant?.amount_max) parts.push(`Amount: $${grant.amount_requested || grant.amount_max}`)
  // The funder's own stated award range, when the row carries one.
  if (!grant?.amount_requested && !grant?.amount_max && (opportunity?.amount_min || opportunity?.amount_max)) {
    const lo = opportunity.amount_min ? `$${opportunity.amount_min}` : null
    const hi = opportunity.amount_max ? `$${opportunity.amount_max}` : null
    parts.push(`Stated award range: ${[lo, hi].filter(Boolean).join(' - ')}`)
  }
  if (grant?.program_description) parts.push(`Program: ${grant.program_description}`)
  if (grant?.eligibility_summary) parts.push(`Eligibility: ${grant.eligibility_summary}`)
  if (grant?.selection_criteria) parts.push(`Criteria: ${grant.selection_criteria}`)
  if (opportunity?.description) parts.push(`Description: ${opportunity.description}`)
  if (opportunity?.eligibility_bullets) parts.push(`Eligibility: ${opportunity.eligibility_bullets}`)
  // The funder's own eligibility prose (funding_opportunities.eligibility_text)
  // — the strongest tailoring signal the row can carry.
  if (opportunity?.eligibility_text) parts.push(`Funder's stated eligibility: ${opportunity.eligibility_text}`)
  const focusAreas = safeParseArrayField(opportunity?.categories, [])
    .slice(0, 8)
    .map((v) => String(v))
    .filter(Boolean)
  if (focusAreas.length > 0) parts.push(`Funder focus areas: ${focusAreas.join(', ')}`)
  return parts.join('\n')
}

function buildProfileContext(profile) {
  if (!profile) return 'No profile data available.'
  const parts = []
  parts.push(`Applicant: ${profile.display_name || profile.name || 'Unknown'}`)
  if (profile.state) parts.push(`Location: ${profile.city || ''} ${profile.state} ${profile.zip_code || ''}`.trim())
  if (profile.primary_type) parts.push(`Type: ${profile.primary_type}`)
  const s = profile.sections || {}
  // Section keys must match the canonical schema (see backend/config/profileSchema.js
  // and gatherProfileForApplication above). Earlier this function read short
  // aliases like `s.financial` / `s.health` that never exist on the loaded row,
  // which silently starved every LLM prompt of real grounding and let the model
  // fabricate "plausible" content. Use the real keys + a small alias fallback
  // so older callers still work.
  const pick = (...keys) => {
    for (const k of keys) {
      const v = s?.[k]
      if (v && (typeof v !== 'object' || Object.keys(v).length > 0)) return v
    }
    return null
  }
  const demographics = pick('demographics')
  const financial = pick('financial_information', 'financial')
  const health = pick('health_medical', 'health')
  const education = pick('education', 'education_background', 'education_information')
  const military = pick('military_service', 'military')
  const family = pick('family_household', 'family', 'household')
  const govAssist = pick('government_assistance', 'benefits_received')
  const employment = pick('employment_income', 'employment')
  const housing = pick('housing', 'housing_situation')
  const disabilities = pick('disabilities_accessibility', 'disabilities')
  const programs = pick('programs_services', 'programs_and_services')
  const orgInfo = pick('organization_information', 'organization')
  const narrative = pick('narrative', 'mission_narrative')
  if (demographics) parts.push(`Demographics: ${JSON.stringify(demographics)}`)
  if (financial) parts.push(`Financial: ${JSON.stringify(financial)}`)
  if (health) parts.push(`Health: ${JSON.stringify(health)}`)
  if (education) parts.push(`Education: ${JSON.stringify(education)}`)
  if (military) parts.push(`Military: ${JSON.stringify(military)}`)
  if (family) parts.push(`Family: ${JSON.stringify(family)}`)
  if (govAssist) parts.push(`Government Assistance: ${JSON.stringify(govAssist)}`)
  if (employment) parts.push(`Employment: ${JSON.stringify(employment)}`)
  if (housing) parts.push(`Housing: ${JSON.stringify(housing)}`)
  if (disabilities) parts.push(`Disabilities: ${JSON.stringify(disabilities)}`)
  if (programs) parts.push(`Programs/Services: ${JSON.stringify(programs)}`)
  if (orgInfo) parts.push(`Organization: ${JSON.stringify(orgInfo)}`)
  if (narrative) parts.push(`Narrative/Mission: ${JSON.stringify(narrative)}`)
  return parts.join('\n')
}

function buildSectionPrompt(sectionKey, title, grantContext, profileContext, grant) {
  const base = `Write the "${title}" section for this grant application.\n\nGRANT DETAILS:\n${grantContext}\n\nAPPLICANT PROFILE:\n${profileContext}\n\n`

  switch (sectionKey) {
    case 'cover_letter':
      return base + 'Write a professional cover letter addressed to the funder\'s review committee. Include the specific grant name, amount requested, and why this applicant is an ideal candidate. Keep it to one page.'
    case 'needs_statement':
      return base + 'Write a compelling statement of need that grounds every claim in the applicant\'s real data. Use demographics, health conditions, financial circumstances, and geographic factors. Reference relevant statistics for the area. 300-500 words.'
    case 'project_narrative':
      return base + 'Write a detailed project narrative explaining what the funding will be used for, with measurable objectives, a realistic timeline, and expected outcomes. Tie back to the funder\'s mission.'
    case 'budget_justification': {
      // Anti-hallucination: when no real amount is on file, refuse to invent
      // a "$10,000 budget" the funder will never read. Explicit instruction
      // wins over the model's bias to fill the section regardless.
      const requested = grant?.amount_requested
      const max = grant?.amount_max
      const knownAmount =
        requested !== undefined && requested !== null && requested !== ''
          ? requested
          : max !== undefined && max !== null && max !== ''
            ? max
            : null
      if (!knownAmount) {
        return (
          base +
          `IMPORTANT: There is no requested amount or known maximum award on file for this opportunity. ` +
          `Do NOT invent dollar amounts or line items. Output a single short paragraph explaining that the budget ` +
          `cannot be drafted until a requested amount is captured on the grant record, and list the data points the ` +
          `user needs to add (requested amount, line-item categories, any match requirement). Do not produce ` +
          `tuition / fees / books / transportation lines without verified data.`
        )
      }
      return (
        base +
        `Write a budget justification showing how the requested funds ($${knownAmount}) will be allocated. ` +
        `Use ONLY line items that are directly supported by the grant context above and the applicant profile. ` +
        `If a category (e.g. tuition, equipment, transportation) cannot be backed by a real fact in the context, ` +
        `omit it. Each line must include the dollar amount and a one-sentence justification tied to a real ` +
        `applicant data point.`
      )
    }
    case 'organization_background':
      return base + 'Write an applicant background section highlighting relevant qualifications, history, and capacity. For individuals, focus on personal circumstances, education, employment, and community involvement.'
    case 'personal_statement':
      return base + 'Write a first-person personal statement / scholarship essay for this applicant. Ground every claim in the applicant\'s real education, activities, circumstances, and goals from the profile — explain why the applicant is pursuing their field of study and how this scholarship advances that path. Never invent schools, GPAs, awards, or experiences that are not in the profile context. 400-600 words.'
    case 'academic_background':
      return base + 'Summarize the applicant\'s academic background: current school or enrollment status, degree or program, GPA, relevant coursework, honors, and awards — using ONLY facts present in the applicant profile above. If a detail (e.g. GPA or transcript data) is not on file, write "not on file" rather than inventing it.'
    case 'financial_need_statement':
      return base + 'Write a financial need statement grounded ONLY in the real financial data in the applicant profile (household income, household size, employment, benefits received). Do NOT invent dollar figures, costs, or circumstances that are not in the context. If financial data is missing from the profile, state plainly which figures need to be added before this section can be completed.'
    case 'activities_leadership':
      return base + 'Describe the applicant\'s extracurricular activities, volunteering, community involvement, employment, and leadership roles using ONLY facts from the profile above, presented as evidence of character and commitment. If none are on file, note that the applicant\'s activities need to be added to the profile — do not fabricate any.'
    case 'evaluation_plan':
      return base + 'Write an evaluation plan explaining how success will be measured, including specific metrics, data collection methods, and reporting timeline.'
    case 'medical_necessity':
      return base + 'Write a Letter of Medical Necessity (LOMN) for this application. Include: patient information, diagnoses with ICD-10 codes where identifiable, functional limitations, medical justification for the requested service/equipment/funding, and a physician signature block. This must be clinically professional and ready for a physician to review and sign.'
    case 'submission_instructions':
      return `Based on this grant information, provide clear submission instructions:\n\n${grantContext}\n\nApplication Method: ${grant?.application_method || 'unknown'}\nPortal URL: ${grant?.application_url || 'N/A'}\nFax: ${grant?.funder_fax || 'N/A'}\nMailing Address: ${grant?.funder_address || 'N/A'}\nContact Email: ${grant?.contact_email || 'N/A'}\nContact Phone: ${grant?.contact_phone || 'N/A'}\n\nProvide step-by-step instructions for how to submit this application.`
    default:
      return base + `Write professional content for the "${title}" section.`
  }
}
