/**
 * SECURITY REGRESSION (share treated as delete-ownership on a legacy profile).
 *
 * For a legacy NULL-user_id profile, isProfileOwnerForDelete used to return true
 * when the actor's email appeared in profile_emails — but profile_emails is the
 * SHARE allowlist, so a COLLABORATOR shared onto the profile could DELETE its
 * documents. Destructive ownership for a NULL-owner profile must be proven ONLY
 * by the profile's own identity email (basic_information.email), never a share.
 */

import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { isProfileOwnerForDelete } = await import('../routes/documents.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    -- Legacy profile with NO owner user_id.
    INSERT INTO profiles (id, user_id) VALUES ('legacy1', NULL);
    -- SHARE: a collaborator's email is on the allowlist.
    INSERT INTO profile_emails (id, profile_id, email) VALUES ('pe1', 'legacy1', 'sharer@collab.example');
    -- OWNER IDENTITY: basic_information.email is the profile's own email.
    INSERT INTO profile_sections (profile_id, section_key, data)
      VALUES ('legacy1', 'basic_information', '{"email":"owner@legacy.example"}');
  `)
  return db
}

describe('isProfileOwnerForDelete — legacy NULL-owner ownership', () => {
  let req
  beforeEach(() => { req = { db: makeDb() } })

  it('DENIES a collaborator whose email is only a SHARE (profile_emails), not owner-identity', async () => {
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'collab-user',
      actorEmail: 'sharer@collab.example',
    })
    expect(ok).toBe(false)
  })

  it('ALLOWS the actual owner whose email is the profile basic_information.email', async () => {
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'owner-user',
      actorEmail: 'owner@legacy.example',
    })
    expect(ok).toBe(true)
  })

  it('DENIES an unrelated email', async () => {
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'someone',
      actorEmail: 'stranger@nowhere.example',
    })
    expect(ok).toBe(false)
  })
})
