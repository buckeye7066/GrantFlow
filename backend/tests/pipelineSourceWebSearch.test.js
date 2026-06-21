/**
 * Pipeline source gate — web-discovered leads.
 *
 * A user who explicitly saves a web_search lead (real URL) must be allowed to
 * add it to their pipeline; the save path then persists it profile-scoped.
 * This pins that allowance without weakening the denials for synthetic /
 * unknown provenance.
 */

import { describe, it, expect } from 'vitest'
import { evaluatePipelineSource, isPipelineSourceAllowed } from '../config/pipelineAllowedSources.js'

describe('evaluatePipelineSource — web_search leads', () => {
  it('allows a web_search record_origin (provenance)', () => {
    const res = evaluatePipelineSource({ source: 'web_search', record_origin: 'web_search' })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('trusted_origin')
  })

  it('allows a web_search source even when record_origin is absent (inline lead save)', () => {
    const res = evaluatePipelineSource({ source: 'web_search', record_origin: null })
    expect(res.allowed).toBe(true)
  })

  it('still denies synthetic origins', () => {
    const res = evaluatePipelineSource({ source: 'web_search', record_origin: 'synthetic' })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('untrusted_origin')
  })

  it('still denies an unknown/unlisted source with no trusted origin', () => {
    const res = evaluatePipelineSource({ source: 'some_random_blog', record_origin: null })
    expect(res.allowed).toBe(false)
  })

  it('web_search is in the allowed source list', () => {
    expect(isPipelineSourceAllowed('web_search')).toBe(true)
  })
})
