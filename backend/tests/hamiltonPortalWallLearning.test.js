/**
 * "Learn the wall once" — Hamilton records a stable server-side / IP-reputation
 * wall the FIRST time a portal refuses the datacenter browser, then diverts
 * every later attempt away from the doomed launch.
 *
 * Covers:
 *   - isServerWallSignal: a WAF connection reset / 403 / named anti-bot vendor is
 *     a wall; a DNS failure / connection timeout is NOT (that's an outage).
 *   - recordPortalWallObservation → getPortalWallStatus.blocked (learned once).
 *   - repeat observation bumps hits, keeps first_seen_at, stays confirmed.
 *   - a confirmed wall older than the re-probe TTL reads dueForReprobe (self-heal
 *     path), NOT permanently blocked.
 *   - clearPortalWall lifts the block but keeps the audit trail.
 *   - learning a wall never destroys the host's existing policy (studentaid.gov
 *     stays automation_allowed:false / manual_only).
 *   - a never-observed portal is not blocked.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default

const {
  recordPortalWallObservation,
  getPortalWallStatus,
  clearPortalWall,
  getPolicyFor,
  _resetPortalPolicySchemaCache,
} = await import('../services/hamilton/hamiltonPortalPolicyRegistry.js')

const { isServerWallSignal } = await import('../services/hamilton/hamiltonBlockerClassifier.js')

function makeDb() {
  return new Database(':memory:')
}

describe('isServerWallSignal', () => {
  it('flags stable server-side walls', () => {
    expect(isServerWallSignal('page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://studentaid.gov')).toBe(true)
    expect(isServerWallSignal('Access Denied — Reference #18.abcd')).toBe(true)
    expect(isServerWallSignal('Request blocked by Akamai')).toBe(true)
    expect(isServerWallSignal('HTTP 403 Forbidden')).toBe(true)
    expect(isServerWallSignal('Too Many Requests (429)')).toBe(true)
    expect(isServerWallSignal('datadome challenge')).toBe(true)
  })

  it('does NOT flag transient outages or bad URLs as walls', () => {
    expect(isServerWallSignal('page.goto: net::ERR_NAME_NOT_RESOLVED')).toBe(false)
    expect(isServerWallSignal('net::ERR_CONNECTION_TIMED_OUT')).toBe(false)
    expect(isServerWallSignal('getaddrinfo ENOTFOUND foo.example')).toBe(false)
    expect(isServerWallSignal('stayed_on_blank_page (target: https://x.test)')).toBe(false)
    expect(isServerWallSignal('')).toBe(false)
    expect(isServerWallSignal(null)).toBe(false)
  })
})

describe('portal wall learning', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    _resetPortalPolicySchemaCache()
  })

  it('a never-observed portal is not blocked', async () => {
    const status = await getPortalWallStatus(db, 'example.org')
    expect(status.blocked).toBe(false)
    expect(status.block).toBeNull()
  })

  it('records a wall on the first observation and blocks the next attempt', async () => {
    const block = await recordPortalWallObservation(db, {
      portalHost: 'walledportal.test',
      signal: 'net::ERR_HTTP2_PROTOCOL_ERROR',
      engine: 'chromium-new-headless',
    })
    expect(block.state).toBe('confirmed')
    expect(block.hits).toBe(1)

    const status = await getPortalWallStatus(db, 'walledportal.test')
    expect(status.blocked).toBe(true)
    expect(status.block.signal).toContain('ERR_HTTP2_PROTOCOL_ERROR')
    expect(status.block.engine).toBe('chromium-new-headless')
  })

  it('a repeat observation bumps hits but keeps first_seen_at', async () => {
    const first = await recordPortalWallObservation(db, { portalHost: 'walledportal.test', signal: 'akamai' })
    const second = await recordPortalWallObservation(db, { portalHost: 'walledportal.test', signal: 'akamai' })
    expect(second.hits).toBe(2)
    expect(second.first_seen_at).toBe(first.first_seen_at)
    expect(second.state).toBe('confirmed')
  })

  it('a confirmed wall older than the re-probe TTL is due for re-probe, not permanently blocked', async () => {
    await recordPortalWallObservation(db, { portalHost: 'walledportal.test', signal: 'akamai' })
    // Age the stored observation ~30 days into the past (TTL default is 7 days).
    const row = await db.prepare('SELECT metadata_json FROM hamilton_portal_policies WHERE portal_host = ?').get('walledportal.test')
    const metadata = JSON.parse(row.metadata_json)
    metadata.datacenter_block.last_seen_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    await db.prepare('UPDATE hamilton_portal_policies SET metadata_json = ? WHERE portal_host = ?')
      .run(JSON.stringify(metadata), 'walledportal.test')

    const status = await getPortalWallStatus(db, 'walledportal.test')
    expect(status.blocked).toBe(false)
    expect(status.dueForReprobe).toBe(true)
  })

  it('clearPortalWall lifts the block but keeps the audit trail', async () => {
    await recordPortalWallObservation(db, { portalHost: 'walledportal.test', signal: 'akamai' })
    const cleared = await clearPortalWall(db, 'walledportal.test')
    expect(cleared.cleared).toBe(true)

    const status = await getPortalWallStatus(db, 'walledportal.test')
    expect(status.blocked).toBe(false)
    const policy = await getPolicyFor(db, 'walledportal.test')
    expect(policy.datacenter_block.state).toBe('cleared')
    expect(policy.datacenter_block.cleared_at).toBeTruthy()
  })

  it('learning a wall does not destroy the host\'s existing policy (studentaid.gov stays manual-only)', async () => {
    await recordPortalWallObservation(db, { portalHost: 'studentaid.gov', signal: 'net::ERR_HTTP2_PROTOCOL_ERROR' })
    const policy = await getPolicyFor(db, 'studentaid.gov')
    expect(policy.automation_allowed).toBe(false)
    expect(policy.manual_only).toBe(true)
    expect(policy.datacenter_block.state).toBe('confirmed')
  })
})
