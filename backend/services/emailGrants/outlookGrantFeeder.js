/**
 * Outlook → Grant feeder.
 *
 * Reads recent messages from the configured Microsoft 365 mailbox
 * (dr.johnwhite@axiombiolabs.org, via the already-consented app-only Graph
 * integration used by John) and pipes grant-announcement emails into the
 * email→grant ingestor. This is the "bridge" that lets GrantFlow parse grants
 * straight from the inbox — no Gmail, no Apps Script, no manual forwarding.
 *
 * Cost control: a light keyword pre-filter keeps obvious non-grant mail
 * (receipts, threads, calendar) from hitting the AI parser. Everything that
 * passes is deduped by message-id and parsed; the AI still returns is_grant
 * false for anything that isn't a real opportunity.
 */

import { createOutlookProvider } from '../john/johnOutlookProvider.js'
import { ingestEmails } from './emailGrantIngestor.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:outlookGrantFeeder')

// Subject/body cues that an email is (or links to) a funding opportunity.
const GRANT_HINTS = /\b(grant|grants|funding|fund |rfp|rfa|nofo|notice of funding|foundation|scholarship|fellowship|award|solicitation|call for proposals|application deadline|apply by|request for (proposals|applications))\b/i

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function messageToEmail(m) {
  const body = m?.body || {}
  const text =
    body.contentType && String(body.contentType).toLowerCase() === 'html'
      ? stripHtml(body.content)
      : String(body.content || '').trim()
  return {
    messageId: m?.internetMessageId || m?.id || null,
    from: m?.from?.emailAddress?.address || null,
    fromName: m?.from?.emailAddress?.name || null,
    subject: m?.subject || null,
    text: text || m?.bodyPreview || '',
    receivedAt: m?.receivedDateTime || null,
    source: 'outlook_inbox',
  }
}

export function looksLikeGrant(email) {
  const hay = `${email.subject || ''} ${email.text || ''}`
  return GRANT_HINTS.test(hay)
}

/**
 * Pull recent inbox messages and ingest the grant-looking ones.
 *
 * @param {object} db
 * @param {{ provider?: object, top?: number, sinceIso?: string|null, skipFilter?: boolean }} [opts]
 *        provider is injectable for tests; defaults to the real Graph provider.
 */
export async function runOutlookGrantFeed(db, { provider = null, top = 25, sinceIso = null, skipFilter = false } = {}) {
  const ms = provider || createOutlookProvider()
  if (ms.notConfigured || ms.ready === false) {
    return { ok: false, reason: 'outlook_not_configured', missing: ms.missing || null }
  }

  let messages = []
  try {
    const res = await ms.listInboxMessages({ top, sinceIso })
    messages = res?.messages || []
  } catch (err) {
    log.error('inbox read failed', { error: err?.message, code: err?.code })
    return { ok: false, reason: 'inbox_read_failed', detail: err?.message }
  }

  const all = messages.map(messageToEmail).filter((e) => e.messageId)
  const candidates = skipFilter ? all : all.filter(looksLikeGrant)
  log.info('outlook feed', { fetched: messages.length, candidates: candidates.length })

  if (candidates.length === 0) {
    return { ok: true, fetched: messages.length, candidates: 0, summary: { received: 0, imported: 0, skipped: 0, rejected: 0, duplicate: 0, error: 0 }, results: [] }
  }

  const { summary, results } = await ingestEmails(db, candidates)
  return { ok: true, fetched: messages.length, candidates: candidates.length, summary, results }
}
