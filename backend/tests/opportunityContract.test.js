import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildOpportunityReadModel,
  deriveOpportunityStatus,
} from '../services/opportunityContract.js'
import { listOpportunityRecords } from '../services/opportunityRepository.js'

const NOW = new Date('2026-08-17T12:00:00.000Z')

describe('opportunity lifecycle contract', () => {
  it.each([
    [{ deadline: '2026-09-15' }, 'open', 'Open'],
    [{ deadline: '2026-08-25' }, 'closing_soon', 'Closing soon'],
    [{ deadline: '2026-08-16' }, 'closed', 'Closed'],
    [{ open_date: '2026-09-01', current_status: 'forecasted' }, 'forecasted', 'Opens soon'],
    [{ deadline_type: 'rolling' }, 'rolling', 'Rolling'],
    [{}, 'unknown', 'Status not confirmed'],
  ])('derives plain-language status from stored facts', (row, code, label) => {
    expect(deriveOpportunityStatus(row, { now: NOW })).toMatchObject({ code, label })
  })

  it('lists with every static source/status filter shape and keeps totals independent of pagination', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE funding_opportunities (
          id TEXT PRIMARY KEY,
          source TEXT,
          current_status TEXT,
          title TEXT,
          deadline TEXT,
          created_at TEXT
        );
        INSERT INTO funding_opportunities VALUES
          ('federal-open', 'grants_gov', 'open', 'Federal open', '2027-01-10', '2026-01-01'),
          ('federal-closed', 'grants_gov', 'closed', 'Federal closed', '2025-01-10', '2026-01-02'),
          ('state-open', 'state_portal', 'open', 'State open', '2027-02-10', '2026-01-03'),
          ('state-forecasted', 'state_portal', 'forecasted', 'State forecasted', NULL, '2026-01-04');
      `)

      const all = await listOpportunityRecords(db, { limit: 2 })
      expect(all.data).toHaveLength(2)
      expect(all.total).toBe(4)

      const bySource = await listOpportunityRecords(db, { source: 'grants_gov' })
      expect(bySource.data.map((row) => row.id)).toEqual(['federal-closed', 'federal-open'])
      expect(bySource.total).toBe(2)

      const byStatus = await listOpportunityRecords(db, { status: 'open' })
      expect(new Set(byStatus.data.map((row) => row.id))).toEqual(new Set(['federal-open', 'state-open']))
      expect(byStatus.total).toBe(2)

      const combined = await listOpportunityRecords(db, { source: 'grants_gov', status: 'open' })
      expect(combined.data.map((row) => row.id)).toEqual(['federal-open'])
      expect(combined.total).toBe(1)
    } finally {
      db.close()
    }
  })

  it('reopens a deadline-derived closed projection when the source extends the deadline', () => {
    expect(deriveOpportunityStatus({
      current_status: 'closed',
      source_status: 'open',
      deadline: '2026-10-01',
      is_active: true,
    }, { now: NOW })).toMatchObject({
      code: 'open',
      label: 'Open',
      basis: 'future_deadline',
    })
  })

  it('returns structured missing fields without inventing publication or verification facts', () => {
    const model = buildOpportunityReadModel({
      id: 'opp-1',
      source: 'grants.gov',
      source_id: 'ABC-123',
      title: 'Community Resilience Program',
      sponsor: 'Federal Emergency Agency',
      description: 'Supports local resilience projects.',
      categories: JSON.stringify(['community']),
      entity_types_allowed: JSON.stringify(['nonprofit']),
      geo_eligibility: JSON.stringify({ national: true, states: [] }),
      eligibility_requirements: JSON.stringify({ bullets: ['Eligible nonprofits'] }),
      amount_min: 10000,
      amount_max: 50000,
      deadline: '2026-09-15',
      application_url: 'https://www.grants.gov/search-results-detail/123',
      source_url: 'https://www.grants.gov/search-results-detail/123',
      created_at: '2026-08-01T00:00:00.000Z',
      link_status: 'unverified',
    }, { now: NOW })

    expect(model.funding_range).toEqual({ min: 10000, max: 50000, currency: 'USD' })
    expect(model.current_status).toBe('open')
    expect(model.status_label).toBe('Open')
    expect(model.first_published_at).toBeNull()
    expect(model.last_verified_at).toBeNull()
    expect(model.verification.code).toBe('unverified')
    expect(model.missing_fields).toContain('first_published_at')
    expect(model.missing_fields).toContain('last_verified_at')
  })
})
