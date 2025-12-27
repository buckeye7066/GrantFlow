import { getDb } from '../../db/index.js'
import { logAudit } from '../../audit/logger.js'

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
      
      // Only apply if confidence is above threshold (0.7)
      if (confidence >= 0.7) {
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
      
      if (confidence >= 0.7) {
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
