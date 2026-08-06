/**
 * yanaContactsImport.js — turn the owner's personal contacts into Yana leads.
 *
 * Yana normally discovers prospect ORGANIZATIONS from public sources; this lets
 * the owner seed leads from people they already know (email contacts, and any
 * social contacts they can export). Each contact becomes a row in
 * yana_lead_candidates with source='owner_contacts', deduped by email, status
 * 'candidate' (NOT auto-pushed to John — these are warm personal contacts the
 * owner reviews, not public-evidence cold leads).
 *
 * Connection reality (documented for the owner):
 *   - Email contacts: paste/upload a list, or wire Google People API OAuth for
 *     Gmail. Yahoo has no open contacts API — export to CSV and import.
 *   - Facebook / Instagram FRIENDS: NOT available via any API (Meta removed
 *     friend-list access in 2015; Instagram has no friends endpoint). The only
 *     compliant path is a manual export the owner provides.
 */

import crypto from 'crypto'
import { ensureYanaLeadSchema } from './yanaLeadDiscovery.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function nameFromEmail(email) {
  const local = String(email).split('@')[0] || ''
  return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || email
}

/**
 * @param {object} db
 * @param {object} args
 * @param {Array<{email?:string,name?:string}|string>} args.contacts
 * @param {string} [args.source='owner_contacts']
 * @param {string} [args.actorUserId]
 * @returns {Promise<{imported:number, skipped:number, invalid:number, details:Array}>}
 */
export async function importContactsAsLeads(db, { contacts = [], source = 'owner_contacts', actorUserId = null } = {}) {
  if (!db) throw new Error('db required')
  if (typeof ensureYanaLeadSchema === 'function') await ensureYanaLeadSchema(db)

  const isPg = db?.dialect === 'postgres'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  let imported = 0
  let skipped = 0
  let invalid = 0
  const details = []

  for (const raw of Array.isArray(contacts) ? contacts : []) {
    const email = String((raw && typeof raw === 'object' ? raw.email : raw) || '').trim().toLowerCase()
    const name = (raw && typeof raw === 'object' && raw.name) ? String(raw.name).trim() : nameFromEmail(email)
    if (!email || !EMAIL_RE.test(email)) { invalid += 1; continue }

    // Dedup by (source, external_id=email).
    try {
      const existing = await db.prepare('SELECT id FROM yana_lead_candidates WHERE source = ? AND external_id = ? LIMIT 1').get(source, email)
      if (existing) { skipped += 1; details.push({ email, status: 'duplicate' }); continue }
    } catch { /* table just created */ }

    const id = crypto.randomUUID()
    const orgId = `owner-contact:${crypto.createHash('sha256').update(`${source}:${email}`).digest('hex').slice(0, 24)}`
    const evidence = JSON.stringify([{ summary: `Imported from the owner's ${source.replace(/_/g, ' ')}.`, source }])
    try {
      await db
        .prepare(
          `INSERT INTO yana_lead_candidates
             (id, organization_id, source, external_id, entity_type, organization_name, contact_email,
              public_evidence_json, source_urls_json, lead_score, qualification_status, qualification_reasons_json,
              run_id, discovered_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'contact', ?, ?, ?, '[]', 40, 'candidate', ?, NULL, ${nowFn}, ${nowFn}, ${nowFn})`,
        )
        .run(id, orgId, source, email, name, email, evidence, JSON.stringify([`owner_import_by:${actorUserId || 'admin'}`]))
      imported += 1
      details.push({ email, status: 'imported', name })
    } catch (err) {
      // organization_id collision (re-import) → treat as duplicate.
      skipped += 1
      details.push({ email, status: 'duplicate_or_error', error: err?.message })
    }
  }

  return { imported, skipped, invalid, details }
}

/**
 * Parse a contacts CSV (Google Contacts / Outlook / generic "Name,Email") into
 * [{email, name}]. Header-aware (finds any email column and a name / first-name
 * / last-name column); falls back to detecting an email-looking cell per row.
 */
export function parseContactsCsv(text) {
  if (!text || typeof text !== 'string') return []
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const splitRow = (line) => line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
  const header = splitRow(lines[0]).map((h) => h.toLowerCase())
  const emailIdx = header.findIndex((h) => /e-?mail/.test(h))
  const nameIdx = header.findIndex((h) => h === 'name' || /full ?name|display ?name/.test(h))
  const firstIdx = header.findIndex((h) => /first ?name/.test(h))
  const lastIdx = header.findIndex((h) => /last ?name/.test(h))
  const hasHeader = emailIdx !== -1 || nameIdx !== -1 || firstIdx !== -1
  const out = []
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = splitRow(line)
    let email = emailIdx !== -1 ? cells[emailIdx] : null
    let name = nameIdx !== -1 ? cells[nameIdx] : null
    if (!name && (firstIdx !== -1 || lastIdx !== -1)) name = [cells[firstIdx], cells[lastIdx]].filter(Boolean).join(' ').trim() || null
    if (!email) email = cells.find((c) => EMAIL_RE.test(c)) || null
    if (email) out.push({ email, name: name || null })
  }
  return out
}

function ownerSeedContactsFromEnv(env = process.env) {
  // Environment contract: process.env.OWNER_CONTACT_EMAILS
  const configured = String(env.OWNER_CONTACT_EMAILS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => EMAIL_RE.test(value))
  if (configured.length > 0) return [...new Set(configured)]

  const deployed = String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
    || Boolean(String(env.RAILWAY_ENVIRONMENT_ID || '').trim())
    || Boolean(String(env.RAILWAY_DEPLOYMENT_ID || '').trim())
  if (deployed) return []
  return [
    'demo.owner-gmail@example.invalid',
    'demo.owner-yahoo-primary@example.invalid',
    'demo.owner-yahoo-secondary@example.invalid',
    'demo.owner-graph@example.invalid',
  ]
}

/** Owner self-addresses are private configuration; production has no defaults. */
export const OWNER_SEED_CONTACTS = Object.freeze(ownerSeedContactsFromEnv())
