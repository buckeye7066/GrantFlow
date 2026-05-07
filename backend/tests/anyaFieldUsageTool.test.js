import { describe, it, expect } from 'vitest'
import { invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'

describe('Anya field-usage tools (Goal 11)', () => {
  it('registers fieldUsage.explain in the public tool registry', () => {
    const meta = listToolMetadata({ isAdmin: false })
    const ids = meta.map((t) => t.name)
    expect(ids).toContain('fieldUsage.explain')
    expect(ids).toContain('fieldUsage.listForSection')
    expect(ids).toContain('fieldUsage.coverageReport')
  })

  it('fieldUsage.explain returns canonical why_we_ask copy for a known field', async () => {
    const wrapper = await invokeTool('fieldUsage.explain', { field_id: 'organization.uei' })
    const result = wrapper.output
    expect(result.field_id).toBe('organization.uei')
    expect(result.why_we_ask).toMatch(/UEI|federal/i)
    expect(Array.isArray(result.usage_modes)).toBe(true)
    expect(result.usage_modes.length).toBeGreaterThan(0)
  })

  it('fieldUsage.explain reports PII fields as PII and forbids external use', async () => {
    const wrapper = await invokeTool('fieldUsage.explain', { field_id: 'pii.ssn' })
    const result = wrapper.output
    expect(result.pii).toBe(true)
    expect(result.raw_external_use_allowed).toBe(false)
    expect(result.usage_modes).not.toContain('crawler_query')
  })

  it('fieldUsage.explain throws a 404 for unknown field ids', async () => {
    await expect(
      invokeTool('fieldUsage.explain', { field_id: 'totally.fake.field' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('fieldUsage.listForSection returns entries scoped to the requested section', async () => {
    const wrapper = await invokeTool('fieldUsage.listForSection', { section: 'organization_details' })
    const result = wrapper.output
    expect(result.section).toBe('organization_details')
    expect(result.count).toBeGreaterThan(0)
    expect(result.entries.every((e) => typeof e.why_we_ask === 'string')).toBe(true)
  })

  it('fieldUsage.coverageReport surfaces totals and PII compliance counters', async () => {
    const wrapper = await invokeTool('fieldUsage.coverageReport', {})
    const result = wrapper.output
    expect(typeof result.total_fields).toBe('number')
    expect(result.total_fields).toBeGreaterThan(50)
    expect(result.pii_external_query_violations).toBeDefined()
  })
})
