import crypto from 'crypto'
import JSZip from 'jszip'
import { writeApplicationArtifact } from './storageAdapter.js'
import { createOpenAIClient } from '../utils/openaiClient.js'
import { requiresMedicalNecessity, generateMedicalNecessityDocument, DOCUMENT_TYPES } from '../services/medicalNecessity.js'
import { assertAllowedKeySet, buildEqualityWhereClause } from '../utils/safeSql.js'

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

  const safeTable = tableEntry.table
  const uniqueWhereSql = buildEqualityWhereClause(uniqueKeys)

  const existing = await db
    .prepare(`SELECT id FROM ${safeTable} WHERE ${uniqueWhereSql} LIMIT 1`)
    .get(...uniqueValues)

  if (existing?.id) {
    await db.prepare(updateSql).run(...updateParams, existing.id)
    const updated = await db.prepare(`SELECT * FROM ${safeTable} WHERE id = ?`).get(existing.id)
    return { row: updated, created: false, mode: 'updated' }
  }

  const id = crypto.randomUUID()
  await db.prepare(insertSql).run(id, ...insertParams)
  const createdRow = await db.prepare(`SELECT * FROM ${safeTable} WHERE id = ?`).get(id)
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

  return db.prepare('SELECT * FROM applications WHERE id = ?').get(id)
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
          } catch {
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

  return db.prepare('SELECT * FROM applications WHERE id = ?').get(String(applicationId))
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
  const t = title !== undefined ? (title == null ? null : String(title)) : null
  const c = content !== undefined ? (content == null ? null : String(content)) : null

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
  const l = label !== undefined ? (label == null ? null : String(label)) : null
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

  // Merge snapshot for auditability.
  let prev = null
  try {
    prev = app.snapshot_json ? JSON.parse(app.snapshot_json) : null
  } catch {
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
    try {
      await tx
        .prepare(
          `
            UPDATE grants
            SET status = 'submitted',
                updated_at = ${nowSqlLiteral(db)}
            WHERE id = ?
          `,
        )
        .run(String(app.grant_id))
    } catch {
      // best-effort only (some environments may not have grants.status constraints aligned)
    }

    // Record a milestone for the submission event (best-effort, non-fatal).
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
    } catch {
      // ignore
    }
  })

  return db.prepare('SELECT * FROM applications WHERE id = ?').get(String(applicationId))
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
  const opportunity = grant?.funding_opportunity_id
    ? await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(grant.funding_opportunity_id)
    : null

  const medNecCheck = requiresMedicalNecessity(opportunity || {})

  const defaultSections = [
    { section_key: 'cover_letter', title: 'Cover Letter' },
    { section_key: 'needs_statement', title: 'Statement of Need' },
    { section_key: 'project_narrative', title: 'Project Narrative' },
    { section_key: 'budget_justification', title: 'Budget Justification' },
    { section_key: 'organization_background', title: 'Applicant Background' },
    { section_key: 'evaluation_plan', title: 'Evaluation Plan' },
    ...(medNecCheck.required ? [{ section_key: 'medical_necessity', title: 'Medical Necessity Documentation' }] : []),
    { section_key: 'submission_instructions', title: 'Submission Instructions' },
  ]

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
    try { parsed[s.section_key] = typeof s.data === 'string' ? JSON.parse(s.data) : s.data } catch { /* skip */ }
  }
  return { ...profile, sections: parsed }
}

async function generateApplicationSections(db, grant, opportunity, profile, sectionDefs) {
  const result = {}
  let openai = null
  try { openai = createOpenAIClient({ allowMissing: true }).openai } catch { /* no key */ }
  if (!openai) {
    console.log('[autoPopulate] No OpenAI key; generating template-based content only')
    return generateTemplateSections(db, grant, opportunity, profile, sectionDefs)
  }

  const grantContext = buildGrantContext(grant, opportunity)
  const profileContext = buildProfileContext(profile)

  for (const section of sectionDefs) {
    try {
      const prompt = buildSectionPrompt(section.section_key, section.title, grantContext, profileContext, grant)
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: GRANT_WRITER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      })
      result[section.section_key] = completion.choices?.[0]?.message?.content?.trim() || ''
    } catch (err) {
      console.warn(`[autoPopulate] AI generation failed for ${section.section_key}:`, err.message)
      result[section.section_key] = ''
    }
  }
  return result
}

async function generateTemplateSections(db, grant, opportunity, profile, sectionDefs) {
  const result = {}
  const name = profile?.display_name || profile?.name || 'the applicant'
  const title = grant?.title || opportunity?.title || 'this funding opportunity'
  const funder = grant?.funder || opportunity?.sponsor || 'the funding organization'

  for (const s of sectionDefs) {
    if (s.section_key === 'submission_instructions') {
      result[s.section_key] = buildSubmissionInstructions(grant, opportunity)
    } else if (s.section_key === 'medical_necessity') {
      try {
        const medDoc = await generateMedicalNecessityDocument(db, grant?.profile_id, {
          opportunityId: opportunity?.id, grantId: grant?.id,
        })
        result[s.section_key] = medDoc?.content || '[Medical necessity documentation will be generated when health data is available in the profile.]'
      } catch {
        result[s.section_key] = '[Medical necessity documentation requires health information in the profile. Please update the health_medical section.]'
      }
    } else if (s.section_key === 'cover_letter') {
      result[s.section_key] = `Dear ${funder} Review Committee,\n\nI am writing to express my interest in ${title}. ${name} meets the eligibility criteria for this opportunity and respectfully requests consideration for funding.\n\n[This section will be enhanced with AI when available. Please review and customize.]\n\nSincerely,\n${name}`
    } else {
      result[s.section_key] = ''
    }
  }
  return result
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

function buildGrantContext(grant, opportunity) {
  const parts = []
  parts.push(`Grant/Opportunity: ${grant?.title || opportunity?.title || 'Unknown'}`)
  parts.push(`Funder: ${grant?.funder || opportunity?.sponsor || 'Unknown'}`)
  if (grant?.deadline) parts.push(`Deadline: ${grant.deadline}`)
  if (grant?.amount_requested || grant?.amount_max) parts.push(`Amount: $${grant.amount_requested || grant.amount_max}`)
  if (grant?.program_description) parts.push(`Program: ${grant.program_description}`)
  if (grant?.eligibility_summary) parts.push(`Eligibility: ${grant.eligibility_summary}`)
  if (grant?.selection_criteria) parts.push(`Criteria: ${grant.selection_criteria}`)
  if (opportunity?.description) parts.push(`Description: ${opportunity.description}`)
  if (opportunity?.eligibility_bullets) parts.push(`Eligibility: ${opportunity.eligibility_bullets}`)
  return parts.join('\n')
}

function buildProfileContext(profile) {
  if (!profile) return 'No profile data available.'
  const parts = []
  parts.push(`Applicant: ${profile.display_name || profile.name || 'Unknown'}`)
  if (profile.state) parts.push(`Location: ${profile.city || ''} ${profile.state} ${profile.zip_code || ''}`.trim())
  if (profile.primary_type) parts.push(`Type: ${profile.primary_type}`)
  const s = profile.sections || {}
  if (s.demographics) parts.push(`Demographics: ${JSON.stringify(s.demographics)}`)
  if (s.financial) parts.push(`Financial: ${JSON.stringify(s.financial)}`)
  if (s.health) parts.push(`Health: ${JSON.stringify(s.health)}`)
  if (s.education) parts.push(`Education: ${JSON.stringify(s.education)}`)
  if (s.military) parts.push(`Military: ${JSON.stringify(s.military)}`)
  if (s.family) parts.push(`Family: ${JSON.stringify(s.family)}`)
  if (s.government_assistance) parts.push(`Government Assistance: ${JSON.stringify(s.government_assistance)}`)
  if (s.employment) parts.push(`Employment: ${JSON.stringify(s.employment)}`)
  if (s.housing) parts.push(`Housing: ${JSON.stringify(s.housing)}`)
  if (s.disabilities) parts.push(`Disabilities: ${JSON.stringify(s.disabilities)}`)
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
    case 'budget_justification':
      return base + `Write a budget justification showing how the requested funds (${grant?.amount_requested || grant?.amount_max || 'requested amount'}) will be allocated. Include line items with amounts and clear justifications for each.`
    case 'organization_background':
      return base + 'Write an applicant background section highlighting relevant qualifications, history, and capacity. For individuals, focus on personal circumstances, education, employment, and community involvement.'
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

const GRANT_WRITER_SYSTEM_PROMPT = `You are a seasoned grant writer with an MBA and 15+ years of experience securing federal, state, and foundation funding for individuals and organizations. You write at the highest professional standard.

RULES:
- Use the applicant's REAL profile data throughout — never use placeholders like [INSERT NAME] or generic text
- Ground every needs statement in real demographics, health, financial, and geographic data
- Write with authority, using data-driven language that is compelling but not clinical
- Structure content with clear paragraphs and professional formatting
- Be specific about amounts, dates, locations, and measurable outcomes
- Write as if this application must compete against hundreds of others — it must stand out
- Every section should demonstrate alignment between the applicant's needs and the funder's mission
- For submission instructions, provide exact URLs, addresses, fax numbers, and step-by-step guidance`

