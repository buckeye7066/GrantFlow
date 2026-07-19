/**
 * SECURITY REGRESSION (round 17): OTP-verify profile ADOPTION must be bound to
 * the PRESENTED credential. A verified email/phone code proves control of that
 * credential, NOT ownership of an arbitrary unowned profile id. Before this fix,
 * `attachProfileToUser` attached ANY unowned profile to whoever presented an
 * OTP — so an OTP holder who knew an unrelated, unowned profile id could CLAIM
 * it (tenant takeover). The email path may only adopt a profile whose email
 * matches the just-verified email; the phone path (no email binding) may only
 * RE-SELECT an already-owned profile, never adopt an unowned one.
 */

import { describe, expect, it, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { attachProfileToUser, profileIsBoundToEmail } = await import('../routes/auth.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, updated_at TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT, updated_by TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT, added_by TEXT);

    INSERT INTO users (id, primary_email) VALUES ('u-attacker', 'attacker@evil.example');
    INSERT INTO users (id, primary_email) VALUES ('u-victim', 'victim@good.example');

    -- An UNOWNED profile whose email is victim@good.example (a baseline/imported stub).
    INSERT INTO profiles (id, user_id) VALUES ('p-unowned-victim', NULL);
    INSERT INTO profile_sections (profile_id, section_key, data)
      VALUES ('p-unowned-victim', 'basic_information', '{"email":"victim@good.example"}');

    -- An UNOWNED profile with NO email binding at all.
    INSERT INTO profiles (id, user_id) VALUES ('p-unowned-blank', NULL);

    -- A profile already OWNED by the attacker (re-selection should be allowed).
    INSERT INTO profiles (id, user_id) VALUES ('p-attacker-own', 'u-attacker');

    -- A profile owned by someone ELSE (never adoptable).
    INSERT INTO profiles (id, user_id) VALUES ('p-someone-else', 'u-victim');
  `)
  return db
}

let db
beforeEach(() => { db = makeDb() })

describe('attachProfileToUser (email OTP path) binds adoption to the verified email', () => {
  it('DENIES adopting an unowned profile whose email does NOT match the verified email (tenant takeover)', async () => {
    // Attacker verified attacker@evil.example, tries to claim victim's unowned profile.
    await expect(
      attachProfileToUser(db, 'u-attacker', 'p-unowned-victim', { verifiedEmail: 'attacker@evil.example' }),
    ).rejects.toMatchObject({ status: 403 })
    // The profile stays unowned — no takeover.
    const row = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-unowned-victim')
    expect(row.user_id).toBeNull()
  })

  it('DENIES adopting an unowned profile with no email binding', async () => {
    await expect(
      attachProfileToUser(db, 'u-attacker', 'p-unowned-blank', { verifiedEmail: 'attacker@evil.example' }),
    ).rejects.toMatchObject({ status: 403 })
    const row = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-unowned-blank')
    expect(row.user_id).toBeNull()
  })

  it('ALLOWS adopting an unowned profile whose basic_information.email MATCHES the verified email', async () => {
    const id = await attachProfileToUser(db, 'u-victim', 'p-unowned-victim', { verifiedEmail: 'victim@good.example' })
    expect(id).toBe('p-unowned-victim')
    const row = db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-unowned-victim')
    expect(row.user_id).toBe('u-victim')
  })

  it('ALLOWS adopting an unowned profile bound via an explicit profile_emails grant', async () => {
    db.prepare("INSERT INTO profile_emails (id, profile_id, email, added_by) VALUES ('pe1', 'p-unowned-blank', 'victim@good.example', 'test')").run()
    const id = await attachProfileToUser(db, 'u-victim', 'p-unowned-blank', { verifiedEmail: 'victim@good.example' })
    expect(id).toBe('p-unowned-blank')
    expect(db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-unowned-blank').user_id).toBe('u-victim')
  })

  it('DENIES adopting a profile owned by ANOTHER user, even with a matching verified email', async () => {
    // p-someone-else is owned by u-victim; attacker verified an email — still 403 (owned).
    await expect(
      attachProfileToUser(db, 'u-attacker', 'p-someone-else', { verifiedEmail: 'victim@good.example' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-someone-else').user_id).toBe('u-victim')
  })

  it('ALLOWS re-selecting a profile the SAME user already owns', async () => {
    const id = await attachProfileToUser(db, 'u-attacker', 'p-attacker-own', { verifiedEmail: 'attacker@evil.example' })
    expect(id).toBe('p-attacker-own')
  })
})

describe('attachProfileToUser (phone OTP path, no verifiedEmail) cannot adopt unowned profiles', () => {
  it('DENIES adopting an unowned profile even when its email would match some email (no phone->profile binding exists)', async () => {
    await expect(
      attachProfileToUser(db, 'u-victim', 'p-unowned-victim'),
    ).rejects.toMatchObject({ status: 403 })
    expect(db.prepare('SELECT user_id FROM profiles WHERE id = ?').get('p-unowned-victim').user_id).toBeNull()
  })

  it('ALLOWS re-selecting a profile the SAME user already owns', async () => {
    const id = await attachProfileToUser(db, 'u-attacker', 'p-attacker-own')
    expect(id).toBe('p-attacker-own')
  })
})

describe('profileIsBoundToEmail', () => {
  it('is true for basic_information.email match, false for a mismatch', async () => {
    expect(await profileIsBoundToEmail(db, 'p-unowned-victim', 'victim@good.example')).toBe(true)
    expect(await profileIsBoundToEmail(db, 'p-unowned-victim', 'attacker@evil.example')).toBe(false)
  })

  it('is false for a profile with no binding and false for empty inputs', async () => {
    expect(await profileIsBoundToEmail(db, 'p-unowned-blank', 'anyone@example.com')).toBe(false)
    expect(await profileIsBoundToEmail(db, null, 'x@example.com')).toBe(false)
    expect(await profileIsBoundToEmail(db, 'p-unowned-victim', '')).toBe(false)
  })
})
