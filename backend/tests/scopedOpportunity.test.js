/**
 * Unit tests for backend/utils/scopedOpportunity.js.
 *
 * We stub the db.prepare().get() API with a small in-memory table store so
 * we can assert the scoped helpers only return opportunities that are linked
 * through the owning application row. No real SQLite is needed — the tests
 * focus on query routing and scoping behaviour.
 */
import { describe, it, expect } from 'vitest'
import {
  getScopedOpportunityForApplication,
  getScopedOpportunityForVnextApplication,
  getScopedOpportunityForProfile,
  assertOpportunityVisibleToProfile,
} from '../utils/scopedOpportunity.js'

function makeFakeDb({ vnext = [], legacyApps = [], grants = [], opportunities = [] } = {}) {
  return {
    prepare(sql) {
      const norm = sql.replace(/\s+/g, ' ').trim()
      return {
        get(...args) {
          const id = args[0]

          if (norm.startsWith('SELECT * FROM vnext_applications WHERE id = ?')) {
            return vnext.find((a) => a.id === id) || undefined
          }
          if (norm.includes('FROM funding_opportunities fo') && norm.includes('JOIN vnext_applications va ON va.opportunity_id = fo.id')) {
            if (norm.includes('va.profile_id = ?')) {
              const pid = args[0]
              const oid = args[1]
              const link = vnext.find((v) => v.profile_id === pid && v.opportunity_id === oid)
              if (!link) return undefined
              return opportunities.find((o) => o.id === oid) || undefined
            }
            const link = vnext.find((v) => v.id === id)
            if (!link) return undefined
            return opportunities.find((o) => o.id === link.opportunity_id) || undefined
          }
          if (norm.startsWith('SELECT id, grant_id FROM applications WHERE id = ?')) {
            return legacyApps.find((a) => a.id === id) || undefined
          }
          if (norm.startsWith('SELECT id, funding_opportunity_id FROM grants WHERE id = ?')) {
            return grants.find((g) => g.id === id) || undefined
          }
          if (norm.startsWith('SELECT * FROM funding_opportunities WHERE id = ? AND profile_id = ?')) {
            const [oid, pid] = args
            return opportunities.find((o) => o.id === oid && o.profile_id === pid) || undefined
          }
          if (norm.startsWith('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')) {
            return opportunities.find((o) => o.id === id) || undefined
          }
          if (norm.includes('FROM funding_opportunities fo') && norm.includes('JOIN grants g ON g.funding_opportunity_id = fo.id')) {
            const [pid, oid] = args
            const grant = grants.find((g) => g.profile_id === pid && g.funding_opportunity_id === oid)
            if (!grant) return undefined
            return opportunities.find((o) => o.id === oid) || undefined
          }
          return undefined
        },
      }
    },
  }
}

describe('scopedOpportunity helpers', () => {
  it('getScopedOpportunityForVnextApplication returns opportunity only for the linked vnext app', () => {
    const db = makeFakeDb({
      vnext: [{ id: 'a1', opportunity_id: 'o1', profile_id: 'p1' }],
      opportunities: [{ id: 'o1', title: 'Linked' }, { id: 'o-other', title: 'Unlinked' }],
    })

    return getScopedOpportunityForVnextApplication(db, 'a1').then((res) => {
      expect(res.reason).toBe('OK')
      expect(res.opportunity.title).toBe('Linked')
    })
  })

  it('returns APPLICATION_NOT_FOUND when vnext app id is unknown', async () => {
    const db = makeFakeDb({})
    const res = await getScopedOpportunityForVnextApplication(db, 'missing')
    expect(res.reason).toBe('APPLICATION_NOT_FOUND')
  })

  it('returns OPPORTUNITY_NOT_LINKED when vnext app has no opportunity id', async () => {
    const db = makeFakeDb({
      vnext: [{ id: 'a1', opportunity_id: null, profile_id: 'p1' }],
    })
    const res = await getScopedOpportunityForVnextApplication(db, 'a1')
    expect(res.reason).toBe('OPPORTUNITY_NOT_LINKED')
  })

  it('getScopedOpportunityForApplication walks application → grant → opportunity', async () => {
    const db = makeFakeDb({
      legacyApps: [{ id: 'app1', grant_id: 'g1' }],
      grants: [{ id: 'g1', funding_opportunity_id: 'o1' }],
      opportunities: [{ id: 'o1', title: 'Real' }],
    })
    const res = await getScopedOpportunityForApplication(db, 'app1')
    expect(res.reason).toBe('OK')
    expect(res.opportunity.title).toBe('Real')
  })

  it('getScopedOpportunityForApplication returns GRANT_NOT_LINKED when app has no grant', async () => {
    const db = makeFakeDb({ legacyApps: [{ id: 'app2', grant_id: null }] })
    const res = await getScopedOpportunityForApplication(db, 'app2')
    expect(res.reason).toBe('GRANT_NOT_LINKED')
  })

  it('assertOpportunityVisibleToProfile refuses cross-profile access', async () => {
    const db = makeFakeDb({
      vnext: [{ id: 'a1', opportunity_id: 'o1', profile_id: 'p1' }],
      opportunities: [{ id: 'o1', title: 'p1-scoped' }],
    })

    const ok = await getScopedOpportunityForProfile(db, 'p1', 'o1')
    expect(ok.reason).toBe('OK_VNEXT')

    const blocked = await getScopedOpportunityForProfile(db, 'p-intruder', 'o1')
    expect(blocked.opportunity).toBe(null)
    expect(blocked.reason).toBe('NOT_SCOPED')

    await expect(assertOpportunityVisibleToProfile(db, 'p-intruder', 'o1')).rejects.toMatchObject({
      code: 'OPPORTUNITY_NOT_SCOPED',
    })
  })
})
