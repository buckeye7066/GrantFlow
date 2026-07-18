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

describe('isProfileOwnerForDelete — SQLite json1-absent fallback compares ONLY the root email', () => {
  // Force the json_extract path to throw (simulating a build without JSON1) so the
  // JS-parse fallback runs. It must compare ONLY basic_information.email (root) —
  // NOT a substring of the whole JSON (which would let a NESTED contact email pass).
  function stub({ sectionData }) {
    return {
      // no `dialect` => sqlite branch
      prepare(sql) {
        const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
        if (norm.includes('from profiles where id')) return { get: () => ({ user_id: null }) } // NULL owner
        if (norm.includes('json_extract')) return { get: () => { throw new Error('no json1 in this build') } }
        if (norm.includes('from profile_sections') && norm.includes('data')) {
          return { get: () => ({ data: sectionData }) }
        }
        return { get: () => null }
      },
    }
  }

  it('DENIES when the actor email is only in a NESTED contact field (not root basic_information.email)', async () => {
    const req = { db: stub({ sectionData: '{"email":"owner@legacy.example","contacts":[{"email":"shared@collab.example"}]}' }) }
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'collab-user',
      actorEmail: 'shared@collab.example',
    })
    expect(ok).toBe(false)
  })

  it('ALLOWS the root-email owner via the JS-parse fallback', async () => {
    const req = { db: stub({ sectionData: '{"email":"owner@legacy.example","contacts":[{"email":"shared@collab.example"}]}' }) }
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'owner-user',
      actorEmail: 'owner@legacy.example',
    })
    expect(ok).toBe(true)
  })

  it('FAILS CLOSED on unparseable section JSON', async () => {
    const req = { db: stub({ sectionData: '{not valid json' }) }
    const ok = await isProfileOwnerForDelete(req, {
      profileId: 'legacy1',
      actorUserId: 'x',
      actorEmail: 'owner@legacy.example',
    })
    expect(ok).toBe(false)
  })
})
