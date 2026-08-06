import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

const adminRouter = (await import('../routes/admin.js')).default

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { id: 'admin-1', userId: 'admin-1', role: 'admin', is_admin: 1 }
    req.ctx = { userId: 'admin-1', identityResolved: true, isAdmin: true }
    next()
  })
  app.use('/api/admin', adminRouter)
  return app
}

describe('legacy global Geo Crawl retirement', () => {
  it('returns an explicit 410 without creating or dispatching a job', async () => {
    let databaseCalls = 0
    const db = {
      prepare() {
        databaseCalls += 1
        throw new Error('retired endpoint must not access the database')
      },
      exec() {
        databaseCalls += 1
        throw new Error('retired endpoint must not access the database')
      },
    }

    const response = await request(createApp(db))
      .post('/api/admin/geo/crawl/start')
      .send({ state: 'OH', zip_list: ['43004'] })

    expect(response.status).toBe(410)
    expect(response.body).toMatchObject({
      ok: false,
      error: 'geo_crawl_start_retired',
      code: 'GEO_CRAWL_START_RETIRED',
      replacement: 'profile_scoped_crawler_os',
    })
    expect(response.body).not.toHaveProperty('job')
    expect(response.body).not.toHaveProperty('run_id')
    expect(databaseCalls).toBe(0)
  })
})
