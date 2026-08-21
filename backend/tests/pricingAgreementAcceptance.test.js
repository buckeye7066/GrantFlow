import { describe, expect, it } from 'vitest'

import { acceptAgreement } from '../services/pricing/pricingAccessGate.js'
import { SERVICE_AGREEMENT_VERSION } from '../services/pricing/pricingTypes.js'

function makePgDb({
  pricing = {
    profile_id: 'profile-1',
    user_id: null,
    quote_id: 'quote-1',
    access_status: 'pending_agreement',
    total_cents: 25000,
  },
  agreement = {
    id: 'sa-existing',
    profile_id: 'profile-1',
    user_id: null,
    quote_id: 'quote-1',
    agreement_version: '2026-06-15',
    accepted: 0,
  },
} = {}) {
  const state = {
    pricing: pricing ? { ...pricing } : null,
    agreement: agreement ? { ...agreement } : null,
    statements: [],
    updateSql: null,
    updateArgs: null,
  }

  const db = {
    dialect: 'postgres',
    async withTransaction(fn) {
      return fn(db)
    },
    prepare(sql) {
      state.statements.push(sql)

      if (sql.includes('information_schema.tables')) {
        return { get: async () => ({ ok: 1 }) }
      }

      if (sql.includes('SELECT * FROM profile_pricing')) {
        return { get: async () => state.pricing }
      }

      if (sql.includes('SELECT * FROM service_agreements')) {
        return { get: async () => state.agreement }
      }

      if (sql.includes('INSERT INTO service_agreements')) {
        return {
          run: async (id, userId, profileId, quoteId, agreementVersion) => {
            state.agreement = {
              id,
              user_id: userId,
              profile_id: profileId,
              quote_id: quoteId,
              agreement_version: agreementVersion,
              accepted: 0,
            }
            return { changes: 1 }
          },
        }
      }

      if (sql.includes('UPDATE service_agreements')) {
        return {
          run: async (...args) => {
            state.updateSql = sql
            state.updateArgs = args
            state.agreement = {
              ...state.agreement,
              user_id: state.agreement?.user_id ?? args[0] ?? null,
              quote_id: state.agreement?.quote_id ?? args[1] ?? null,
              accepted: 1,
              accepted_at: args[2],
              accepted_ip: args[3],
              accepted_user_agent: args[4],
              agreement_text_snapshot: state.agreement?.agreement_text_snapshot ?? args[5] ?? null,
            }
            return { changes: 1 }
          },
        }
      }

      if (sql.includes('UPDATE profile_pricing')) {
        return {
          run: async (accessStatus, _updatedAt, profileId) => {
            expect(profileId).toBe(state.pricing?.profile_id)
            state.pricing = { ...state.pricing, access_status: accessStatus }
            return { changes: 1 }
          },
        }
      }

      throw new Error(`Unexpected SQL in test double: ${sql}`)
    },
  }

  return { db, state }
}

describe('acceptAgreement', () => {
  it('updates the latest agreement row by id so Postgres never sees the invalid "user_id IS ?" shape', async () => {
    const { db, state } = makePgDb()

    const result = await acceptAgreement(db, {
      profileId: 'profile-1',
      userId: 'user-1',
      ip: '127.0.0.1',
      userAgent: 'vitest',
      agreementText: 'I agree',
    })

    expect(result).toEqual({ ok: true, access_status: 'pending_payment' })
    expect(state.updateSql).toContain('WHERE id = ?')
    expect(state.updateSql).not.toContain('user_id IS ?')
    expect(state.updateArgs).toMatchObject([
      'user-1',
      'quote-1',
      expect.any(String),
      '127.0.0.1',
      'vitest',
      'I agree',
      'sa-existing',
    ])
    expect(state.agreement?.user_id).toBe('user-1')
    expect(state.agreement?.accepted).toBe(1)
    expect(state.pricing?.access_status).toBe('pending_payment')
  })

  it('recreates a missing agreement row before recording acceptance', async () => {
    const { db, state } = makePgDb({ agreement: null })

    const result = await acceptAgreement(db, {
      profileId: 'profile-1',
      userId: 'user-9',
      ip: '127.0.0.9',
      userAgent: 'vitest',
      agreementText: 'I agree',
    })

    expect(result).toEqual({ ok: true, access_status: 'pending_payment' })
    expect(state.agreement?.id).toMatch(/^sa_/)
    expect(state.agreement?.user_id).toBe('user-9')
    expect(state.agreement?.agreement_version).toBe(SERVICE_AGREEMENT_VERSION)
    expect(state.agreement?.accepted).toBe(1)
  })
})
