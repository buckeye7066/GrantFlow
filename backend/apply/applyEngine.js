import crypto from 'crypto'
import JSZip from 'jszip'
import { writeApplicationArtifact } from './storageAdapter.js'

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

async function upsertByUniqueKey({ db, table, uniqueWhereSql, uniqueParams, insertSql, insertParams, updateSql, updateParams }) {
  const existing = await db.prepare(`SELECT id FROM ${table} WHERE ${uniqueWhereSql} LIMIT 1`).get(...uniqueParams)
  if (existing?.id) {
    await db.prepare(updateSql).run(...updateParams, existing.id)
    const updated = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id)
    return { row: updated, created: false }
  }
  const id = crypto.randomUUID()
  await db.prepare(insertSql).run(id, ...insertParams)
  const createdRow = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  return { row: createdRow, created: true }
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
    uniqueWhereSql: 'application_id = ? AND section_key = ?',
    uniqueParams: [String(applicationId), key],
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
    uniqueWhereSql: 'application_id = ? AND key = ?',
    uniqueParams: [String(applicationId), k],
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

  // Heuristic portal url from grant columns if present.
  let portalUrl = null
  const maybePortal = grant?.application_method ?? null
  if (maybePortal && /^https?:\/\//i.test(String(maybePortal))) portalUrl = String(maybePortal)
  if (!portalUrl && sourceUrl && /^https?:\/\//i.test(String(sourceUrl))) portalUrl = String(sourceUrl)

  const defaultSections = [
    { section_key: 'cover_letter', title: 'Cover Letter', content: '' },
    { section_key: 'project_narrative', title: 'Project Narrative', content: '' },
    { section_key: 'budget_justification', title: 'Budget Justification', content: '' },
    { section_key: 'organization_background', title: 'Organization Background', content: '' },
    { section_key: 'evaluation_plan', title: 'Evaluation Plan', content: '' },
    { section_key: 'attachments', title: 'Attachments / Supporting Docs', content: '' },
  ]

  const defaultChecklist = [
    { key: 'confirm_deadline', label: 'Confirm deadline and timezone', status: 'pending' },
    { key: 'confirm_eligibility', label: 'Confirm eligibility requirements', status: 'pending' },
    { key: 'gather_required_docs', label: 'Gather required documents/attachments', status: 'pending' },
    { key: 'review_budget', label: 'Review budget and match requirements', status: 'pending' },
    { key: 'final_review', label: 'Final review and compliance check', status: 'pending' },
  ]

  await db.withTransaction(async () => {
    if (portalUrl) {
      await patchApplication({
        db,
        applicationId,
        patch: {
          portal_url: portalUrl,
          snapshot_json: { auto_populate: { sources, portal_url_source: sources[0] ?? null } },
        },
      })
    } else {
      await patchApplication({
        db,
        applicationId,
        patch: {
          snapshot_json: { auto_populate: { sources } },
        },
      })
    }

    for (const s of defaultSections) {
      await upsertSection({ db, applicationId, sectionKey: s.section_key, title: s.title, content: s.content })
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
  }
}

