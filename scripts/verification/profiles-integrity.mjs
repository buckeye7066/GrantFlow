#!/usr/bin/env node
/**
 * Profile integrity report (DB evidence).
 * Searches both:
 * - backend/data/grantflow.verify.db
 * - backend/data/grantflow.db
 *
 * Env:
 * - VERIFY_DB_PATH (default backend/data/grantflow.verify.db)
 * - MAIN_DB_PATH (default backend/data/grantflow.db)
 */
import Database from 'better-sqlite3'

const VERIFY_DB = process.env.VERIFY_DB_PATH || 'backend/data/grantflow.verify.db'
const MAIN_DB = process.env.MAIN_DB_PATH || 'backend/data/grantflow.db'

function query(dbPath) {
  const db = new Database(dbPath, { readonly: true })

  const profiles = db
    .prepare(
      `
        SELECT id, display_name, status, user_id, organization_id, created_at
        FROM profiles
        WHERE lower(display_name) LIKE '%focus forward%'
           OR lower(display_name) LIKE '%axiom%'
           OR lower(display_name) LIKE '%biolab%'
        ORDER BY display_name ASC
      `,
    )
    .all()

  const profileEmails = db
    .prepare(
      `
        SELECT profile_id, email, created_at
        FROM profile_emails
        WHERE profile_id IN ('profile-axiom-biolabs', 'profile-demo-faith-nonprofit')
        ORDER BY profile_id ASC, email ASC
      `,
    )
    .all()

  const basicInfo = db
    .prepare(
      `
        SELECT profile_id, data
        FROM profile_sections
        WHERE section_key = 'basic_information'
          AND profile_id IN ('profile-axiom-biolabs', 'profile-demo-faith-nonprofit')
        ORDER BY profile_id ASC
      `,
    )
    .all()
    .map((r) => {
      let parsed = {}
      try {
        parsed = r?.data ? JSON.parse(r.data) : {}
      } catch {
        parsed = {}
      }
      return {
        profile_id: r.profile_id,
        email: parsed?.email ?? parsed?.contact_email ?? null,
        website: parsed?.website ?? null,
        name: parsed?.full_name ?? parsed?.name ?? null,
      }
    })

  const orgs = db
    .prepare(
      `
        SELECT id, name, created_at
        FROM organizations
        WHERE lower(name) LIKE '%axiom%'
           OR lower(name) LIKE '%biolab%'
        ORDER BY name ASC
      `,
    )
    .all()

  const focusForwardId = db
    .prepare(`SELECT id FROM profiles WHERE id = 'profile-demo-faith-nonprofit' LIMIT 1`)
    .get()

  const focusForwardTombstone = db
    .prepare(`SELECT profile_id, deleted_at, reason FROM profile_tombstones WHERE profile_id = 'profile-demo-faith-nonprofit' LIMIT 1`)
    .get()

  db.close()
  return {
    dbPath,
    profiles,
    profile_emails: profileEmails,
    basic_information: basicInfo,
    orgs,
    focus_forward_seed_id_present: Boolean(focusForwardId?.id),
    focus_forward_tombstone: focusForwardTombstone || null,
  }
}

console.log(
  JSON.stringify(
    {
      verify: query(VERIFY_DB),
      main: query(MAIN_DB),
    },
    null,
    2,
  ),
)

