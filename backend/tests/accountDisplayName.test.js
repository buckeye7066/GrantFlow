import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb } from './testServer.js'
import { isPlaceholderAccountName, syncAccountDisplayName } from '../services/accountDisplayName.js'

describe('isPlaceholderAccountName', () => {
  it('recognises the email local part, phone stubs, and empties as placeholders', () => {
    expect(isPlaceholderAccountName('mcnabbwg', { email: 'mcnabbwg@yahoo.com' })).toBe(true)
    expect(isPlaceholderAccountName('MCNABBWG', { email: 'mcnabbwg@yahoo.com' })).toBe(true)
    expect(isPlaceholderAccountName('User 0123', { phone: '+15555550123' })).toBe(true)
    expect(isPlaceholderAccountName('User abc123')).toBe(true)
    expect(isPlaceholderAccountName('New User')).toBe(true)
    expect(isPlaceholderAccountName('')).toBe(true)
    expect(isPlaceholderAccountName(null)).toBe(true)
  })
  it('never treats a chosen name as a placeholder', () => {
    expect(isPlaceholderAccountName('Gene McNabb', { email: 'mcnabbwg@yahoo.com' })).toBe(false)
    expect(isPlaceholderAccountName('mcnabbwg', { email: 'someone.else@yahoo.com' })).toBe(false)
  })
})

describe('syncAccountDisplayName', () => {
  let db
  beforeAll(async () => { db = (await getAppAndDb()).db }, 60_000)
  beforeEach(() => { try { db.prepare("DELETE FROM users WHERE id LIKE 'adn-%'").run() } catch { /* */ } })

  function seed(id, displayName, email) {
    db.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').run(id, displayName, email)
  }
  const nameOf = (id) => db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name

  it('replaces an email-derived account name with the profile name', async () => {
    seed('adn-1', 'mcnabbwg', 'mcnabbwg@yahoo.com')
    const r = await syncAccountDisplayName(db, 'adn-1', 'GeneMac')
    expect(r).toEqual({ updated: true, from: 'mcnabbwg', to: 'GeneMac' })
    expect(nameOf('adn-1')).toBe('GeneMac')
  })
  it('leaves a name the person chose alone', async () => {
    seed('adn-2', 'Gene McNabb', 'mcnabbwg@yahoo.com')
    const r = await syncAccountDisplayName(db, 'adn-2', 'GeneMac')
    expect(r.updated).toBe(false)
    expect(nameOf('adn-2')).toBe('Gene McNabb')
  })
  it('is a no-op for an empty profile name or a missing user', async () => {
    seed('adn-3', 'mcnabbwg', 'mcnabbwg@yahoo.com')
    expect((await syncAccountDisplayName(db, 'adn-3', '')).updated).toBe(false)
    expect((await syncAccountDisplayName(db, 'adn-missing', 'GeneMac')).updated).toBe(false)
    expect(nameOf('adn-3')).toBe('mcnabbwg')
  })
})
