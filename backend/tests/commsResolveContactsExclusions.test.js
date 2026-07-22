/**
 * resolveProfileContacts recipient-exclusion guards.
 *
 * Two owner requirements, enforced at the single contact-resolution choke point
 * every profile-directed comms path (weekly digest, portal reminders, broadcast)
 * funnels through:
 *
 *   1. The operator (admin) is NEVER a recipient. Admin owns/created most
 *      profiles, so users.primary_email resolves to the admin address on nearly
 *      every profile; without the guard the digest CC's the operator alongside
 *      the real profile owner.
 *   2. Non-routable RFC-6761 .invalid addresses (Amy's synthetic profiles use
 *      amy+<scenario>@synthetic.grantflow.invalid) are never emailed.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { resolveProfileContacts, isPlaceholderEmail, _ensuredReset } from '../services/comms/commsService.js'
import { ADMIN_EMAIL } from '../config/constants.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, user_id TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT);
    CREATE TABLE profile_emails (id TEXT PRIMARY KEY, profile_id TEXT, email TEXT, is_proxy INTEGER DEFAULT 0);
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

beforeEach(() => {
  if (typeof _ensuredReset === 'function') _ensuredReset()
})

describe('resolveProfileContacts exclusions', () => {
  it('drops the admin (operator) email but keeps the real profile owner', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run('u1', ADMIN_EMAIL)
    db.prepare('INSERT INTO profiles (id, display_name, status, user_id) VALUES (?, ?, ?, ?)')
      .run('p1', 'Acme Org', 'active', 'u1') // owned by admin -> owner_user would be admin
    db.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)')
      .run('e1', 'p1', 'owner@acme.org')

    const contacts = await resolveProfileContacts(db, 'p1')
    const emails = contacts.emails.map((e) => e.email.toLowerCase())
    expect(emails).toContain('owner@acme.org')
    expect(emails).not.toContain(ADMIN_EMAIL.toLowerCase())
    expect(contacts.primary_email).toBe('owner@acme.org')
  })

  it('drops non-routable .invalid addresses (Amy synthetic profiles)', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)')
      .run('amy1', 'Amy Synthetic — Nonprofit #1', 'active')
    db.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)')
      .run('e2', 'amy1', 'amy+nonprofit-v1@synthetic.grantflow.invalid')

    const contacts = await resolveProfileContacts(db, 'amy1')
    expect(contacts.emails).toHaveLength(0)
    expect(contacts.has_usable_email).toBe(false)
    expect(contacts.primary_email).toBeNull()
  })

  it('drops reserved PLACEHOLDER-domain addresses (example.com class) so digests skip instead of erroring', async () => {
    // REGRESSION (prod 2026-07-21): profiles seeded with someone@example.com
    // flowed into the Hamilton weekly digest, Resend rejected the recipient,
    // and each surfaced as a SEND ERROR every week. A placeholder is
    // structurally "no email on file" — the digest must count it
    // skipped_no_email, which falls out of it never becoming a contact here.
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)')
      .run('p2', 'Placeholder Family', 'active')
    for (const [i, email] of [
      'jane@example.com', 'j@example.org', 'x@example.net', 'a@sub.example.com',
      'b@myapp.test', 'c@localhost', 'd@dev.localhost', 'e@anything.example',
    ].entries()) {
      db.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)').run(`ph${i}`, 'p2', email)
    }
    const contacts = await resolveProfileContacts(db, 'p2')
    expect(contacts.emails).toHaveLength(0)
    expect(contacts.has_usable_email).toBe(false)
    expect(contacts.primary_email).toBeNull()
  })

  it('placeholder guard NEVER swallows a real address that merely resembles one', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)').run('p3', 'Real Org', 'active')
    for (const [i, email] of [
      'grants@example-foundation.org', // hyphenated real domain, not example.org
      'info@testing.org',              // "test" only as a substring
      'jane@localhostel.com',          // "localhost" only as a substring
    ].entries()) {
      db.prepare('INSERT INTO profile_emails (id, profile_id, email) VALUES (?, ?, ?)').run(`r${i}`, 'p3', email)
    }
    const contacts = await resolveProfileContacts(db, 'p3')
    expect(contacts.emails.map((e) => e.email)).toEqual([
      'grants@example-foundation.org', 'info@testing.org', 'jane@localhostel.com',
    ])
  })

  it('isPlaceholderEmail unit contract (terminal-label match only)', () => {
    for (const e of ['a@example.com', 'a@EXAMPLE.ORG', 'a@x.example.net', 'a@b.test', 'a@localhost', 'a@foo.invalid']) {
      expect(isPlaceholderEmail(e), `${e} is a placeholder`).toBe(true)
    }
    for (const e of ['a@example-foundation.org', 'a@contest.org', 'a@protested.com', 'not-an-email', '']) {
      expect(isPlaceholderEmail(e), `${e} is NOT a placeholder`).toBe(false)
    }
  })
})
