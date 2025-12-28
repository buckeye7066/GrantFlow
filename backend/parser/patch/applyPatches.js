import { getDb } from '../../db/index.js'
import { logAudit } from '../../audit/logger.js'

/**
 * Confidence threshold for applying patches
 * Fields with confidence below this value will not be applied
 */
const CONFIDENCE_THRESHOLD = 0.7

/**
 * Apply patches to database
 * Returns summary of changes made
 */
export async function applyPatches(patches, documentId, profileId) {
  const db = getDb()
  const changes = {
    profile: [],
    funding_sources: [],
  }
  
  // Apply profile patches
  if (patches.profile && patches.profile.set) {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`)
    }
    
    const updates = {}
    const beforeSnapshot = { ...profile }
    
    for (const [field, fieldData] of Object.entries(patches.profile.set)) {
      const { value, confidence } = fieldData
      
      // Only apply if confidence is above threshold
      if (confidence >= CONFIDENCE_THRESHOLD) {
        // Check if field is empty or we're improving it
        if (!profile[field] || profile[field] === '') {
          updates[field] = value
          changes.profile.push({
            field,
            oldValue: profile[field],
            newValue: value,
            confidence,
          })
        }
      }
    }
    
    // Apply updates
    if (Object.keys(updates).length > 0) {
      const fields = Object.keys(updates).map(f => `${f} = ?`).join(', ')
      const values = Object.values(updates)
      
      db.prepare(`
        UPDATE profiles 
        SET ${fields}, updated_at = ? 
        WHERE id = ?
      `).run(...values, new Date().toISOString(), profileId)
      
      const afterSnapshot = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
      
      // Log audit trail
      await logAudit({
        documentId,
        entity: 'profile',
        recordId: profileId,
        action: 'update',
        before: beforeSnapshot,
        after: afterSnapshot,
        changes: changes.profile,
      })
    }
  }
  
  // Apply funding source patches
  for (const fundingPatch of patches.funding_sources || []) {
    if (!fundingPatch.upsert_by || !fundingPatch.upsert_by.name) {
      continue
    }
    
    const fundingName = fundingPatch.upsert_by.name
    
    // Check if funding_sources table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='funding_sources'
    `).get()
    
    if (!tableExists) {
      console.log('funding_sources table does not exist, skipping funding source patches')
      continue
    }
    
    // Try to find existing funding source
    let fundingSource = db.prepare(`
      SELECT * FROM funding_sources WHERE name = ?
    `).get(fundingName)
    
    const beforeSnapshot = fundingSource ? { ...fundingSource } : null
    const updates = {}
    
    // Build updates from patch
    for (const [field, fieldData] of Object.entries(fundingPatch.set)) {
      const { value, confidence } = fieldData
      
      if (confidence >= CONFIDENCE_THRESHOLD) {
        // Map field names to database columns
        let dbField = field
        if (field === 'contact_email') dbField = 'email'
        if (field === 'contact_phone') dbField = 'phone'
        
        updates[dbField] = value
        
        changes.funding_sources.push({
          name: fundingName,
          field: dbField,
          oldValue: fundingSource ? fundingSource[dbField] : null,
          newValue: value,
          confidence,
        })
      }
    }
    
    if (Object.keys(updates).length > 0) {
      if (fundingSource) {
        // Update existing
        const fields = Object.keys(updates).map(f => `${f} = ?`).join(', ')
        const values = Object.values(updates)
        
        db.prepare(`
          UPDATE funding_sources 
          SET ${fields}, updated_at = ? 
          WHERE name = ?
        `).run(...values, new Date().toISOString(), fundingName)
      } else {
        // Insert new (if we have minimum required fields)
        updates.name = fundingName
        updates.created_at = new Date().toISOString()
        updates.updated_at = new Date().toISOString()
        
        // Only insert if we have required fields based on schema
        const fields = Object.keys(updates).join(', ')
        const placeholders = Object.keys(updates).map(() => '?').join(', ')
        const values = Object.values(updates)
        
        try {
          db.prepare(`
            INSERT INTO funding_sources (${fields})
            VALUES (${placeholders})
          `).run(...values)
        } catch (error) {
          console.error('Error inserting funding source:', error.message)
        }
      }
      
      const afterSnapshot = db.prepare(`
        SELECT * FROM funding_sources WHERE name = ?
      `).get(fundingName)
      
      // Log audit trail
      await logAudit({
        documentId,
        entity: 'funding_source',
        recordId: fundingName,
        action: fundingSource ? 'update' : 'insert',
        before: beforeSnapshot,
        after: afterSnapshot,
        changes: changes.funding_sources,
      })
    }
  }
  
  return changes
}

export default applyPatches
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
