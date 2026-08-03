import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const routePath = fileURLToPath(new URL('../routes/fundingSources.js', import.meta.url))
const routeSource = readFileSync(routePath, 'utf8')

describe('Funding Sources cold-start audit boundary', () => {
  it('runs the non-persisted fallback only in ordinary product reads', () => {
    expect(routeSource).toContain('if (!readOnlyAudit && presented.total === 0)')
    expect(routeSource).not.toContain('if (presented.total === 0) {')
  })

  it('keeps the fallback read-only and explicitly labeled', () => {
    expect(routeSource).toContain('buildColdStartFundingFallback(req.db, profileContext)')
    expect(routeSource).toContain('cold_start_fallback: coldStart')
  })
})
