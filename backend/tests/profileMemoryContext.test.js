import { describe, expect, it } from 'vitest'
import {
  PROFILE_MEMORY_CONTEXT_CONTRACT,
  loadActiveProfileMemoryContext,
} from '../services/profileMemoryContext.js'
import {
  buildGroundedDraftCoverage,
  loadStoredProfileEvidence,
} from '../services/groundedDrafting.js'

function memoryRow(overrides = {}) {
  return {
    id: 'memory-1',
    profile_id: 'profile-1',
    organization_id: 'org-1',
    memory_key: 'outcomes.families-served',
    kind: 'outcome',
    title: 'Families served last year',
    retention_policy: 'profile_lifetime',
    retention_until: null,
    current_revision: 3,
    updated_at: '2026-08-16T12:00:00.000Z',
    revision_id: 'revision-3',
    value_json: JSON.stringify({ statement: 'We served 250 families last year.' }),
    source_kind: 'document',
    source_ref: 'annual-report-2025',
    provenance_json: JSON.stringify({ page: 8 }),
    payload_redacted: 0,
    revision_created_at: '2026-08-16T12:00:00.000Z',
    ...overrides,
  }
}

function makeDb({ dialect = 'sqlite', memoryRows = [memoryRow()] } = {}) {
  const calls = []
  const db = {
    dialect,
    calls,
    prepare(sql) {
      return {
        get(...params) {
          calls.push({ method: 'get', sql, params })
          if (sql.includes('FROM profiles')) {
            return { id: 'profile-1', display_name: 'Community Housing Network' }
          }
          throw new Error(`Unexpected get query: ${sql}`)
        },
        all(...params) {
          calls.push({ method: 'all', sql, params })
          if (sql.includes('FROM profile_sections')) {
            return [{ section_key: 'mission', data: JSON.stringify({ text: 'Stable housing for families.' }) }]
          }
          if (sql.includes('FROM profile_memory_entries')) return memoryRows
          throw new Error(`Unexpected all query: ${sql}`)
        },
      }
    },
  }
  return db
}

describe('canonical reusable profile-memory context', () => {
  it('projects only exact-profile, current, non-expired, non-redacted memory', async () => {
    const db = makeDb({
      memoryRows: [
        memoryRow(),
        memoryRow({ id: 'other-profile', profile_id: 'profile-2' }),
        memoryRow({
          id: 'expired',
          memory_key: 'expired',
          retention_policy: 'until_date',
          retention_until: '2025-01-01T00:00:00.000Z',
        }),
        memoryRow({ id: 'redacted', memory_key: 'redacted', payload_redacted: 1 }),
      ],
    })

    const context = await loadActiveProfileMemoryContext(db, {
      profileId: 'profile-1',
      at: '2026-08-17T00:00:00.000Z',
      limit: 999,
    })

    expect(PROFILE_MEMORY_CONTEXT_CONTRACT.version).toBe('profile-memory-context-v1')
    expect(context).toEqual([expect.objectContaining({
      id: 'memory-1',
      profile_id: 'profile-1',
      value: { statement: 'We served 250 families last year.' },
      current_revision: 3,
      source: {
        kind: 'document',
        ref: 'annual-report-2025',
        provenance: { page: 8 },
      },
    })])

    const query = db.calls.find((call) => call.sql.includes('FROM profile_memory_entries'))
    expect(query.sql).toContain("e.status = 'active'")
    expect(query.sql).toContain("e.retention_policy <> 'until_date'")
    expect(query.sql).toContain('r.payload_redacted = ?')
    expect(query.params).toEqual([
      'profile-1',
      '2026-08-17T00:00:00.000Z',
      0,
      250,
    ])
  })

  it('uses the PostgreSQL boolean parameter without widening profile scope', async () => {
    const db = makeDb({ dialect: 'postgres' })
    await loadActiveProfileMemoryContext(db, { profileId: 'profile-1' })
    const query = db.calls.find((call) => call.sql.includes('FROM profile_memory_entries'))
    expect(query.params[0]).toBe('profile-1')
    expect(query.params[2]).toBe(false)
  })

  it('feeds active memory into the real grounding evidence and citation contract', async () => {
    const evidence = await loadStoredProfileEvidence(makeDb(), 'profile-1')
    const memorySource = evidence.sources.find((source) => source.source_type === 'profile_memory')
    expect(memorySource).toEqual(expect.objectContaining({
      source_id: 'memory-1',
      revision: 3,
      value: { statement: 'We served 250 families last year.' },
    }))

    const draftText = 'We served 250 families last year.'
    const audit = buildGroundedDraftCoverage({
      draftText,
      requirements: [{
        id: 'req-impact', canonical_key: 'narrative:impact', requirement_type: 'narrative',
        requirement_text: 'Describe prior impact.', mandatory: true, status: 'active', normalized_value: {},
      }],
      requirementResponses: [{
        requirement_id: 'req-impact', response_excerpt: draftText, status: 'addressed', applicant_evidence: [],
      }],
      profileEvidenceSources: evidence.sources,
      applicantNames: evidence.applicantNames,
      claimEvidence: [{
        claim: draftText,
        evidence: [{
          source_type: 'profile_memory',
          source_id: 'memory-1',
          quote_text: 'served 250 families',
        }],
      }],
    })

    expect(audit.can_finalize).toBe(true)
    expect(audit.supported_claims).toHaveLength(1)
    expect(audit.unsupported_claims).toEqual([])
  })

  it('never places expired or redacted payloads in grounding text', async () => {
    const db = makeDb({
      memoryRows: [
        memoryRow({
          id: 'expired',
          retention_policy: 'until_date',
          retention_until: '2020-01-01T00:00:00.000Z',
          value_json: JSON.stringify({ secret: 'expired secret' }),
        }),
        memoryRow({
          id: 'redacted',
          payload_redacted: true,
          value_json: JSON.stringify({ secret: 'redacted secret' }),
        }),
      ],
    })
    const evidence = await loadStoredProfileEvidence(db, 'profile-1')
    expect(evidence.sources.some((source) => source.source_type === 'profile_memory')).toBe(false)
    expect(evidence.text).not.toContain('expired secret')
    expect(evidence.text).not.toContain('redacted secret')
  })
})
