/**
 * Canonical grant fingerprint.
 *
 * Produces a stable sha256 hex over the identity tuple used by the grants
 * pipeline to dedup rows across crawls and across dialects. This is the
 * SAME tuple used by migration 058/0051 to backfill historical rows, so
 * new inserts from matchEngine / applyEngine / routes/grants align with
 * the backfill and dedup works from day one.
 *
 * Identity tuple: (title | funder | deadline | source-like url).
 * Each field is normalized to a trimmed lowercase string with internal
 * whitespace collapsed so trivial formatting differences don't break
 * dedup.
 *
 * Usage:
 *   import { grantFingerprint, GRANT_FINGERPRINT_VERSION } from '.../grantFingerprint.js'
 *   const fp = grantFingerprint({ title, funder, deadline, url })
 */

import crypto from 'crypto'

export const GRANT_FINGERPRINT_VERSION = 1

function norm(v) {
  if (v === null || v === undefined) return ''
  const s = String(v).trim().toLowerCase()
  return s.replace(/\s+/g, ' ')
}

export function chooseGrantUrl(opportunity = {}) {
  const candidates = [
    opportunity.url,
    opportunity.application_url,
    opportunity.applicationUrl,
    opportunity.source_url,
    opportunity.sourceUrl,
    opportunity.portal_url,
    opportunity.portalUrl,
    opportunity.funder_website,
  ]
  for (const u of candidates) {
    if (u && typeof u === 'string') {
      const trimmed = u.trim()
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
    }
  }
  return null
}

export function grantFingerprint({ title, funder, deadline, url } = {}) {
  const tuple = [norm(title), norm(funder), norm(deadline), norm(url)].join('|')
  return crypto.createHash('sha256').update(tuple, 'utf8').digest('hex')
}

/**
 * Convenience: pull the identity tuple from an opportunity-shaped object
 * (what matchEngine / crawlers pass around) so call sites don't have to
 * remember which fields to feed in.
 */
export function grantFingerprintFromOpportunity(opportunity = {}) {
  return grantFingerprint({
    title: opportunity.title,
    funder: opportunity.sponsor || opportunity.funder,
    deadline: opportunity.deadline,
    url: chooseGrantUrl(opportunity),
  })
}
