/**
 * profileGapEmailDrafts — DRAFT-ONLY gap "a few quick questions" emails into the
 * owner's mailbox. Never sends; flag-gated; idempotent.
 */
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { draftGapEmailsForIncompleteProfiles } from '../services/profileGapEmailDrafts.js'
import { normalizeProfile } from '../services/profileNormalizer.js'

function makeDb(profiles = []) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, state TEXT, city TEXT, zip TEXT, status TEXT, deleted_at TEXT);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  for (const p of profiles) {
    db.prepare('INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?,?,?,?)')
      .run(p.id, p.display_name, p.primary_type || 'individual', 'active')
  }
  return db
}

const contactsWithEmail = () => async () => ({ primary_email: 'kathy@example.com', has_usable_email: true, display_name: 'Kathy', emails: [{ email: 'kathy@example.com' }] })
const contactsNoEmail = () => async () => ({ primary_email: null, has_usable_email: false, emails: [] })

describe('draftGapEmailsForIncompleteProfiles', () => {
  it('is OFF by default — creates nothing without the flag or force', async () => {
    const db = makeDb([{ id: 'kathy', display_name: 'Kathy Daniel' }])
    const provider = { createDraft: vi.fn() }
    const res = await draftGapEmailsForIncompleteProfiles(db, { provider, resolveContacts: contactsWithEmail(), normalize: normalizeProfile })
    expect(res.enabled).toBe(false)
    expect(provider.createDraft).not.toHaveBeenCalled()
  })

  it('drafts (never sends) a gap email into the mailbox for an incomplete profile with a usable email', async () => {
    const db = makeDb([{ id: 'kathy', display_name: 'Kathy Daniel' }])
    const provider = { createDraft: vi.fn(async () => ({ provider_draft_id: 'AAMk-DRAFT-1' })) }
    const res = await draftGapEmailsForIncompleteProfiles(db, { force: true, provider, resolveContacts: contactsWithEmail(), normalize: normalizeProfile })
    expect(res.drafted).toBe(1)
    expect(provider.createDraft).toHaveBeenCalledTimes(1)
    const arg = provider.createDraft.mock.calls[0][0]
    expect(arg.toEmail).toBe('kathy@example.com')
    expect(arg.subject).toMatch(/questions/i)
    expect(arg.bodyText).toMatch(/Annie/)
  })

  it('is idempotent — a second run does not re-draft the same profile', async () => {
    const db = makeDb([{ id: 'kathy', display_name: 'Kathy Daniel' }])
    const provider = { createDraft: vi.fn(async () => ({ provider_draft_id: 'AAMk-DRAFT-1' })) }
    const opts = { force: true, provider, resolveContacts: contactsWithEmail(), normalize: normalizeProfile }
    await draftGapEmailsForIncompleteProfiles(db, opts)
    const second = await draftGapEmailsForIncompleteProfiles(db, opts)
    expect(second.drafted).toBe(0)
    expect(second.skipped.already).toBe(1)
    expect(provider.createDraft).toHaveBeenCalledTimes(1)
  })

  it('skips a profile with no usable email', async () => {
    const db = makeDb([{ id: 'noemail', display_name: 'No Email' }])
    const provider = { createDraft: vi.fn() }
    const res = await draftGapEmailsForIncompleteProfiles(db, { force: true, provider, resolveContacts: contactsNoEmail(), normalize: normalizeProfile })
    expect(res.drafted).toBe(0)
    expect(res.skipped.no_email).toBe(1)
    expect(provider.createDraft).not.toHaveBeenCalled()
  })

  it('dry-run counts would-be drafts but creates none', async () => {
    const db = makeDb([{ id: 'kathy', display_name: 'Kathy Daniel' }])
    const provider = { createDraft: vi.fn() }
    const res = await draftGapEmailsForIncompleteProfiles(db, { force: true, dryRun: true, provider, resolveContacts: contactsWithEmail(), normalize: normalizeProfile })
    expect(res.dry_run).toBe(true)
    expect(res.drafted).toBe(1)
    expect(provider.createDraft).not.toHaveBeenCalled()
  })
})
