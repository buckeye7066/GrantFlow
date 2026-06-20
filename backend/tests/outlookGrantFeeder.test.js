/**
 * Unit tests for the Outlook → Grant feeder + the inbox read it relies on.
 *
 * Hermetic: a fake `fetch` stands in for Microsoft Graph, and the feeder's
 * keyword filter is exercised so non-grant mail never reaches the AI parser.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { createOutlookProvider } from '../services/john/johnOutlookProvider.js'
import { messageToEmail, looksLikeGrant, runOutlookGrantFeed } from '../services/emailGrants/outlookGrantFeeder.js'

const CONFIG = { msTenantId: 't', msClientId: 'c', msClientSecret: 's', primaryMailbox: 'dr.johnwhite@axiombiolabs.org' }

function fakeFetch(messages) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push(url)
    if (String(url).includes('/oauth2/v2.0/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' }
    }
    if (String(url).includes('/mailFolders/inbox/messages')) {
      return { ok: true, json: async () => ({ value: messages }), text: async () => '' }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

describe('johnOutlookProvider.listInboxMessages', () => {
  it('reads the inbox via Graph and returns the messages', async () => {
    const msgs = [{ id: '1', internetMessageId: '<a@x>', subject: 'Grant', from: { emailAddress: { address: 'f@x.org' } } }]
    const fetchImpl = fakeFetch(msgs)
    const provider = createOutlookProvider({ fetch: fetchImpl, config: CONFIG })
    const res = await provider.listInboxMessages({ top: 10 })
    expect(res.ok).toBe(true)
    expect(res.messages).toHaveLength(1)
    expect(fetchImpl.calls.some((u) => u.includes('/mailFolders/inbox/messages'))).toBe(true)
  })
})

describe('feeder helpers', () => {
  it('looksLikeGrant distinguishes grant mail from chatter', () => {
    expect(looksLikeGrant({ subject: 'Apply for our 2026 Community Grant', text: '' })).toBe(true)
    expect(looksLikeGrant({ subject: 'NOFO: rural health funding', text: '' })).toBe(true)
    expect(looksLikeGrant({ subject: 'Re: lunch tomorrow?', text: 'see you at noon' })).toBe(false)
  })

  it('messageToEmail strips HTML and prefers the internet message id', () => {
    const email = messageToEmail({
      id: 'graph-1',
      internetMessageId: '<msg-99@x>',
      subject: 'Grant opportunity',
      from: { emailAddress: { address: 'fund@foundation.org', name: 'Foundation' } },
      receivedDateTime: '2026-06-20T10:00:00Z',
      body: { contentType: 'html', content: '<p>Deadline <b>July 1</b></p>' },
    })
    expect(email.messageId).toBe('<msg-99@x>')
    expect(email.from).toBe('fund@foundation.org')
    expect(email.text).toBe('Deadline July 1')
    expect(email.source).toBe('outlook_inbox')
  })
})

describe('runOutlookGrantFeed', () => {
  it('reports not_configured when the mailbox provider is unconfigured', async () => {
    const db = new Database(':memory:')
    const provider = createOutlookProvider({ fetch: fakeFetch([]), config: {} }) // missing creds → notConfigured
    const res = await runOutlookGrantFeed(db, { provider })
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('outlook_not_configured')
  })

  it('filters out non-grant mail so it never reaches the parser', async () => {
    const db = new Database(':memory:')
    const provider = createOutlookProvider({
      fetch: fakeFetch([
        { id: '1', internetMessageId: '<chatter@x>', subject: 'Re: lunch tomorrow?', from: { emailAddress: { address: 'a@b.com' } }, body: { contentType: 'text', content: 'noon?' } },
      ]),
      config: CONFIG,
    })
    const res = await runOutlookGrantFeed(db, { provider })
    expect(res.ok).toBe(true)
    expect(res.fetched).toBe(1)
    expect(res.candidates).toBe(0) // chatter filtered → no ingest, no AI call
  })
})
