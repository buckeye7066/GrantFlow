import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Workforce/union domain engine — profile context.
 *
 * WHY THIS FILE EXISTS. Two defects sat in this engine's filter and between
 * them they returned ZERO of 8 resources for exactly the profiles the engine
 * was built to serve. Both were fixed on a branch that was pushed, never had a
 * pull request opened, and was abandoned 100 commits ago — and the fix shipped
 * with no test, which is why nothing caught that it never landed.
 *
 *   1. `profile.location` is an OBJECT in this codebase — Amy's synthetic
 *      profiles build `location: { city, state, county, zip_code }`
 *      (services/amy/syntheticProfileCatalog.js). The engine did
 *      `userLocation.toLowerCase()`, which throws TypeError on an object. The
 *      catch below logs "Engine failed" and returns an `_engineError` marker,
 *      so every crawl for any profile carrying a location lost all 8 rows —
 *      quietly, as a logged suppression rather than a crash anyone saw.
 *
 *   2. The keyword containment ran BACKWARDS: `kw.includes(token)` asks whether
 *      the short catalog keyword ("training") contains the user's need phrase
 *      ("workforce training assistance"). That is false for all 8 rows, so a
 *      profile that DID declare a workforce need matched nothing, while a
 *      profile with no such need got everything.
 *
 * The engine helper is mocked so these tests measure the FILTER, which is the
 * part that was wrong, rather than the normalisation downstream of it.
 */

vi.mock('../services/crawlers/domainEngines/engineHelper.js', () => ({
  normalizeAndFilter: vi.fn(async (rows) => rows),
}))

const { runWorkforceUnionEngine } = await import(
  '../services/crawlers/domainEngines/workforceUnionEngine.js'
)

const isEngineError = (result) =>
  Array.isArray(result) && result.length === 1 && result[0]?._engineError === true

beforeEach(() => vi.clearAllMocks())

describe('workforce/union engine: profile.location is an object, not a string', () => {
  it('does NOT fail the engine when location is the object shape Amy generates', async () => {
    const profile = {
      location: { city: 'Lorain', state: 'OH', county: 'Lorain County', zip_code: '44052' },
      needs: [{ category: 'workforce' }],
    }
    const result = await runWorkforceUnionEngine(profile)
    expect(isEngineError(result)).toBe(false)
    expect(result.length).toBeGreaterThan(0)
  })

  it('reports the suppressed count honestly IF the engine ever does fail', async () => {
    // Not a defect — the engine's failure shape is deliberately informative,
    // and this pins it so a future change cannot make a failure silent.
    // The throw has to come from INSIDE the try block: profile.needs is read
    // above it, so a profile that explodes on property access escapes the
    // handler entirely rather than being reported as a suppression.
    const { normalizeAndFilter } = await import('../services/crawlers/domainEngines/engineHelper.js')
    normalizeAndFilter.mockRejectedValueOnce(new Error('boom'))
    const result = await runWorkforceUnionEngine({ needs: [{ category: 'workforce' }] })
    expect(isEngineError(result)).toBe(true)
    expect(result[0].suppressed).toBe(8)
    expect(result[0].reason).toMatch(/boom/)
  })

  it('survives a plain-string location too', async () => {
    const result = await runWorkforceUnionEngine({ location: 'Lorain, OH', needs: [{ category: 'workforce' }] })
    expect(isEngineError(result)).toBe(false)
  })

  it('survives a missing location', async () => {
    const result = await runWorkforceUnionEngine({ needs: [{ category: 'workforce' }] })
    expect(isEngineError(result)).toBe(false)
  })
})

describe('workforce/union engine: a declared need must MATCH, not exclude', () => {
  it('a structured { category: "workforce" } need returns resources', async () => {
    const result = await runWorkforceUnionEngine({ needs: [{ category: 'workforce' }] })
    expect(isEngineError(result)).toBe(false)
    expect(result.length).toBeGreaterThan(0)
  })

  it('THE BACKWARDS-CONTAINMENT BUG: a long need phrase still matches a short keyword', async () => {
    // "workforce training assistance" contains "training". The old test asked
    // whether "training" contains "workforce training assistance" — never true.
    const result = await runWorkforceUnionEngine({ needs: ['workforce training assistance'] })
    expect(isEngineError(result)).toBe(false)
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((r) => /training/i.test(JSON.stringify(r)))).toBe(true)
  })

  it('an unemployment need reaches the unemployment row', async () => {
    const result = await runWorkforceUnionEngine({ needs: ['employment and unemployment help'] })
    expect(result.some((r) => /unemployment/i.test(r.title || ''))).toBe(true)
  })

  it('a profile with NO workforce need still gets the unfiltered catalog', async () => {
    // The engine only narrows when a workforce need is declared; this is the
    // control that proves the filter is doing something in the tests above.
    const result = await runWorkforceUnionEngine({ needs: [{ category: 'housing' }] })
    expect(isEngineError(result)).toBe(false)
    expect(result.length).toBe(8)
  })

  it('a declared need narrows the catalog rather than passing everything', async () => {
    // 'employment training' is the useful shape: it clears the need-detection
    // gate (which requires the words 'workforce' or 'employment'), and unlike a
    // phrase containing 'workforce' it does NOT match every row's 'workforce'
    // CATEGORY, so real narrowing is observable. A need mentioning 'workforce'
    // legitimately matches the whole catalog, since every row is categorised
    // workforce — that is the intended behaviour, not a filter that gave up.
    const narrowed = await runWorkforceUnionEngine({ needs: ['employment training'] })
    const unfiltered = await runWorkforceUnionEngine({ needs: [{ category: 'housing' }] })
    expect(narrowed.length).toBeGreaterThan(0)
    expect(narrowed.length).toBeLessThan(unfiltered.length)
  })
})
