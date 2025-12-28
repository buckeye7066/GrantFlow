import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const AUDIT_DIR = path.join(__dirname, '..', '..', 'audit')

async function appendAudit(record) {
  await fs.mkdir(AUDIT_DIR, { recursive: true })
  const file = path.join(AUDIT_DIR, 'document_ingestion.log')
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

function applyProfilePatch(db, profileId, patch) {
  if (!patch || !patch.set) return null
  const fields = {}
  for (const [key, entry] of Object.entries(patch.set)) {
    if (entry && entry.value != null) {
      fields[key] = entry.value
    }
  }
  if (!Object.keys(fields).length) return null

  const current = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
  if (!current) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }

  const assignments = Object.keys(fields)
    .map((key) => `${key} = @${key}`)
    .join(', ')

  const statement = db.prepare(
    `UPDATE profiles SET ${assignments}, updated_at = @updated_at WHERE id = @id`,
  )
  const payload = {
    ...fields,
    updated_at: new Date().toISOString(),
    id: profileId,
  }
  statement.run(payload)
  const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)

  return {
    before: current,
    after: updated,
  }
}

function upsertFundingSource(db, sourcePatch) {
  if (!sourcePatch.set || !sourcePatch.upsert_by?.name) return null
  const name = sourcePatch.upsert_by.name
  const exists = db
    .prepare('SELECT * FROM funding_sources WHERE title = ?')
    .get(name)

  const payload = {
    title: name,
    description: sourcePatch.set.description?.value ?? (exists?.description ?? ''),
    amount: sourcePatch.set.amount?.value ?? exists?.amount ?? null,
    deadline: sourcePatch.set.deadline?.value ?? exists?.deadline ?? null,
    contact_url: sourcePatch.set.website?.value ?? exists?.contact_url ?? null,
    source_url: exists?.source_url ?? null,
    phone: sourcePatch.set.phone?.value ?? exists?.phone ?? null,
    email: sourcePatch.set.email?.value ?? exists?.email ?? null,
    address: sourcePatch.set.address?.value ?? exists?.address ?? null,
    city: sourcePatch.set.city?.value ?? exists?.city ?? null,
    state: sourcePatch.set.state?.value ?? exists?.state ?? null,
    zip_code: sourcePatch.set.zip?.value ?? exists?.zip_code ?? null,
    updated_at: new Date().toISOString(),
  }

  if (exists) {
    db.prepare(
      `UPDATE funding_sources
       SET description=@description, amount=@amount, deadline=@deadline,
           contact_url=@contact_url, source_url=@source_url, phone=@phone, email=@email,
           address=@address, city=@city, state=@state, zip_code=@zip_code,
           updated_at=@updated_at
       WHERE id=@id`,
    ).run({ ...payload, id: exists.id })
    return { before: exists, after: { ...exists, ...payload } }
  }

  const insert = db.prepare(
    `INSERT INTO funding_sources (
      id, state, zip_code, title, description, amount, deadline,
      contact_url, source_url, created_at, updated_at, phone, email, address, city
    ) VALUES (
      @id, @state, @zip_code, @title, @description, @amount, @deadline,
      @contact_url, @source_url, @created_at, @updated_at, @phone, @email, @address, @city
    )`,
  )

  const record = {
    id: sourcePatch.set.id?.value ?? crypto.randomUUID(),
    state: payload.state,
    zip_code: payload.zip_code,
    title: payload.title,
    description: payload.description,
    amount: payload.amount,
    deadline: payload.deadline,
    contact_url: payload.contact_url,
    source_url: payload.source_url,
    created_at: payload.updated_at,
    updated_at: payload.updated_at,
    phone: payload.phone,
    email: payload.email,
    address: payload.address,
    city: payload.city,
  }
  insert.run(record)
  return { before: null, after: record }
}

export async function applyDocumentPatches(db, profileId, patches) {
  const auditEntries = []
  const profileChange = applyProfilePatch(db, profileId, patches.profile)
  if (profileChange) {
    auditEntries.push({
      type: 'profile',
      profileId,
      before: profileChange.before,
      after: profileChange.after,
      timestamp: new Date().toISOString(),
    })
  }

  if (Array.isArray(patches.funding_sources)) {
    for (const source of patches.funding_sources) {
      const result = upsertFundingSource(db, source)
      if (result) {
        auditEntries.push({
          type: 'funding_source',
          identifier: source.upsert_by?.name,
          before: result.before,
          after: result.after,
          timestamp: new Date().toISOString(),
        })
      }
    }
  }

  if (auditEntries.length) {
    for (const entry of auditEntries) {
      await appendAudit(entry)
    }
  }
}
