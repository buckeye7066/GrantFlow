import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import {
  enforceOpportunityLinkProofAfterWrite,
  hasCurrentSuccessfulLinkProof,
  resolveOpportunityLinkProofState,
} from '../services/opportunityLinkProofGuard.js'

const NOW = Date.parse('2026-09-03T20:00:00.000Z')
const FRESH = '2026-09-03T19:00:00.000Z'
const STALE = '2026-07-01T19:00:00.000Z'

function direct(overrides = {}) {
  return {
    id: 'opp-1',
    opportunity_kind: 'DIRECT_GRANT',
    result_kind: 'direct',
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    application_url: 'https://funder.example/apply',
    source_url: 'https://funder.example/program',
    last_verified_at: FRESH,
    link_status: 'ok',
    link_status_code: 200,
    verification_method: 'head',
    verified_by: 'verifier',
    verification_error: null,
    final_url: 'https://funder.example/apply',
    http_status: 200,
    is_hidden: 0,
    ...overrides,
  }
}

describe('opportunity link proof guard', () => {
  it('recognizes only fresh successful proof', () => {
    expect(hasCurrentSuccessfulLinkProof(direct(), NOW)).toBe(true)
    expect(hasCurrentSuccessfulLinkProof(direct({ last_verified_at: STALE }), NOW)).toBe(false)
    expect(hasCurrentSuccessfulLinkProof(direct({ link_status: 'broken' }), NOW)).toBe(false)
    expect(hasCurrentSuccessfulLinkProof(direct({ last_verified_at: null }), NOW)).toBe(false)
  })

  it('preserves current proof on a same-target recrawl that did not probe', () => {
    const beforeRow = direct()
    const currentRow = direct({
      link_status: 'unverified',
      verification_method: null,
      verification_error: null,
    })
    const result = resolveOpportunityLinkProofState({
      beforeRow,
      currentRow,
      input: { ...currentRow, last_verified_at: null },
      nowMs: NOW,
    })
    expect(result.reason).toBe('same_target_preserve_current_proof')
    expect(result.updates.link_status).toBe('ok')
    expect(result.updates.last_verified_at).toBe(FRESH)
    expect(result.updates.is_hidden).toBe(false)
  })

  it('invalidates inherited proof when the effective URL changes without a new probe', () => {
    const beforeRow = direct()
    const currentRow = direct({ application_url: 'https://new.example/apply' })
    const result = resolveOpportunityLinkProofState({
      beforeRow,
      currentRow,
      input: { application_url: 'https://new.example/apply', link_status: 'unverified' },
      nowMs: NOW,
    })
    expect(result.reason).toBe('changed_target_requires_reverification')
    expect(result.updates).toMatchObject({
      last_verified_at: null,
      link_status: 'unverified',
      verification_method: null,
      final_url: null,
      http_status: null,
      is_hidden: true,
    })
  })

  it('lets a fresh negative verdict beat historical success and quarantines the row', () => {
    const beforeRow = direct()
    const input = direct({
      link_status: 'broken',
      link_status_code: 404,
      verification_method: 'get',
      verification_error: 'HTTP 404',
      final_url: null,
      http_status: 404,
    })
    const result = resolveOpportunityLinkProofState({
      beforeRow,
      currentRow: input,
      input,
      nowMs: NOW,
    })
    expect(result.reason).toBe('fresh_non_success_quarantine')
    expect(result.updates.link_status).toBe('broken')
    expect(result.updates.is_hidden).toBe(true)
  })

  it('treats unknown future non-pointer kinds as direct proof-gated rows', () => {
    const result = resolveOpportunityLinkProofState({
      currentRow: direct({
        opportunity_kind: 'FUTURE_AWARD_KIND',
        last_verified_at: null,
        link_status: 'unverified',
      }),
      input: {},
      nowMs: NOW,
    })
    expect(result.reason).toBe('missing_success_quarantine')
    expect(result.updates.is_hidden).toBe(true)
  })

  it('does not impose direct-link proof on structural pointers', () => {
    const result = resolveOpportunityLinkProofState({
      currentRow: direct({
        opportunity_kind: 'DIRECTORY',
        result_kind: 'directory',
        opportunity_type: 'directory',
        type: 'DIRECTORY',
        last_verified_at: null,
        link_status: 'unverified',
      }),
      input: {},
      nowMs: NOW,
    })
    expect(result).toMatchObject({ action: 'none', reason: 'pointer_resource' })
  })

  it('enforces URL-change invalidation against the persisted row', async () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        opportunity_kind TEXT,
        result_kind TEXT,
        opportunity_type TEXT,
        type TEXT,
        application_url TEXT,
        source_url TEXT,
        last_verified_at TEXT,
        link_status TEXT,
        link_status_code INTEGER,
        verification_method TEXT,
        verified_by TEXT,
        verification_error TEXT,
        final_url TEXT,
        http_status INTEGER,
        is_hidden INTEGER DEFAULT 0
      )
    `)
    const beforeRow = direct()
    const after = direct({ application_url: 'https://new.example/apply' })
    db.prepare(`
      INSERT INTO funding_opportunities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      after.id, after.opportunity_kind, after.result_kind, after.opportunity_type, after.type,
      after.application_url, after.source_url, after.last_verified_at, after.link_status,
      after.link_status_code, after.verification_method, after.verified_by,
      after.verification_error, after.final_url, after.http_status, after.is_hidden,
    )

    const result = await enforceOpportunityLinkProofAfterWrite(db, after.id, {
      beforeRow,
      input: { application_url: after.application_url, link_status: 'unverified' },
      nowMs: NOW,
    })
    expect(result.changed).toBe(true)
    const row = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(after.id)
    expect(row.link_status).toBe('unverified')
    expect(row.last_verified_at).toBeNull()
    expect(row.final_url).toBeNull()
    expect(row.is_hidden).toBe(1)
    db.close()
  })
})
