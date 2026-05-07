import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import fieldUsageRouter from '../routes/fieldUsage.js'
import { listFieldUsages } from '../services/profileFieldUsageRegistry.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/field-usage', fieldUsageRouter)
  return app
}

describe('field-usage route (Goal 11)', () => {
  it('GET /api/field-usage returns the full registry bundle and report', async () => {
    const app = createApp()
    const res = await request(app).get('/api/field-usage')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.entries)).toBe(true)
    expect(res.body.entries.length).toBe(listFieldUsages().length)
    // Spot-check that registered fields surface their why_we_ask copy.
    const uei = res.body.entries.find((e) => e.id === 'organization.uei')
    expect(uei).toBeTruthy()
    expect(typeof uei.why_we_ask).toBe('string')
    expect(uei.why_we_ask.length).toBeGreaterThan(0)
    // Coverage report contract for the mission dashboard.
    expect(res.body.report).toBeTruthy()
    expect(typeof res.body.report.total_profile_fields).toBe('number')
    expect(res.body.report.unmapped_fields).toBeDefined()
  })

  it('GET /api/field-usage/:id returns a single entry', async () => {
    const app = createApp()
    const res = await request(app).get('/api/field-usage/organization.uei')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.entry?.id).toBe('organization.uei')
    expect(res.body.entry?.why_we_ask).toMatch(/UEI|federal/i)
  })

  it('GET /api/field-usage/:id 404s for unknown ids without leaking details', async () => {
    const app = createApp()
    const res = await request(app).get('/api/field-usage/totally.fake.field')
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toMatch(/unknown/i)
  })

  it('GET /api/field-usage/report exposes the field-usage coverage summary', async () => {
    const app = createApp()
    const res = await request(app).get('/api/field-usage/report')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.report).toBeTruthy()
    expect(typeof res.body.report.total_profile_fields).toBe('number')
  })

  it('PII fields never declare crawler_query usage in the public bundle', async () => {
    const app = createApp()
    const res = await request(app).get('/api/field-usage')
    const piiEntries = res.body.entries.filter((e) => e.pii)
    expect(piiEntries.length).toBeGreaterThan(0)
    for (const entry of piiEntries) {
      expect(entry.usage_modes || []).not.toContain('crawler_query')
      expect(entry.raw_external_use_allowed).toBe(false)
    }
  })
})
