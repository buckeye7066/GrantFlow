import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import fundingSourcesRouter, {
  classifyFundingSourcesError,
} from '../routes/fundingSources.js'

function createFailingApp(error) {
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', role: 'admin' }
    req.ctx = { userId: 'admin-1', isAdmin: true }
    req.db = {
      prepare() {
        return {
          async get() { throw error },
          async all() { throw error },
          async run() { throw error },
        }
      },
    }
    next()
  })
  app.use('/api', fundingSourcesRouter)
  return app
}

describe('funding-sources failure honesty', () => {
  it('classifies PostgreSQL undefined-column failures without exposing SQL', () => {
    const error = Object.assign(new Error('column fo.summary does not exist'), { code: '42703' })
    expect(classifyFundingSourcesError(error)).toEqual({
      status: 503,
      error: 'FUNDING_SOURCES_UNAVAILABLE',
      failureClass: 'schema_projection_drift',
    })
  })

  it('returns 503 instead of an HTTP-200 empty list when the database query fails', async () => {
    const error = Object.assign(new Error('column fo.summary does not exist'), { code: '42703' })
    const response = await request(createFailingApp(error))
      .get('/api/profiles/p-1/funding-sources?min_score=0')
      .set('x-grantflow-audit-read-only', 'true')

    expect(response.status).toBe(503)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.body).toMatchObject({
      ok: false,
      available: false,
      error: 'FUNDING_SOURCES_UNAVAILABLE',
      failure_class: 'schema_projection_drift',
      details_redacted: true,
      profile_id: 'p-1',
      total: 0,
      sources: [],
      directories: [],
    })
    expect(JSON.stringify(response.body)).not.toContain('fo.summary')
  })

  it('returns 404 for a genuinely missing profile, not a fabricated zero-match result', async () => {
    const error = new Error('Profile p-missing not found')
    const response = await request(createFailingApp(error))
      .get('/api/profiles/p-missing/funding-sources')

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      ok: false,
      available: false,
      error: 'PROFILE_NOT_FOUND',
      failure_class: 'profile_not_found',
    })
  })
})
