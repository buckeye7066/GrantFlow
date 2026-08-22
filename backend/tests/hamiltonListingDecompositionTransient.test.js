/**
 * A listing decomposition that failed because the AI provider was momentarily
 * UNAVAILABLE (exhausted credits, rate limit, 5xx, or no provider configured)
 * must be distinguishable from a page that genuinely lists no awards — so the
 * orchestrator can leave the task RETRYABLE (waiting_for_window) instead of
 * parking it as a manual "needs you" card that never resumes once credits are
 * funded. This pins the classification + propagation + honest message.
 */
import { describe, it, expect } from 'vitest'
import { decomposeListing } from '../services/hamilton/listingDecomposition.js'
import { _internal } from '../services/hamilton/portalSync/llmPageExtract.js'
import { describeDecomposition } from '../services/hamilton/hamiltonAutomationOrchestrator.js'

const { isTransientLlmFailure } = _internal

describe('isTransientLlmFailure', () => {
  it('is TRUE for provider outages / credit / rate-limit signals', () => {
    expect(isTransientLlmFailure(new Error('your credit balance is too low to access the API'))).toBe(true)
    expect(isTransientLlmFailure(new Error('429 Too Many Requests'))).toBe(true)
    expect(isTransientLlmFailure({ status: 503, message: 'Service Unavailable' })).toBe(true)
    expect(isTransientLlmFailure({ anthropicError: { status: 529, message: 'Overloaded' } })).toBe(true)
    expect(isTransientLlmFailure(new Error('ETIMEDOUT'))).toBe(true)
    expect(isTransientLlmFailure(new Error('fetch failed'))).toBe(true)
    expect(isTransientLlmFailure({ openaiError: { message: 'Rate limit reached for requests' } })).toBe(true)
  })

  it('is FALSE for a real answer or a non-transient client error', () => {
    expect(isTransientLlmFailure(new Error('400 invalid request: schema mismatch'))).toBe(false)
    expect(isTransientLlmFailure('no financial-aid awards found in the portal text')).toBe(false)
    expect(isTransientLlmFailure(null)).toBe(false)
    expect(isTransientLlmFailure(undefined)).toBe(false)
    expect(isTransientLlmFailure({})).toBe(false)
  })
})

const profile = { id: 'p1', basic_information: { first_name: 'A' } }
const listing = { url: 'https://f.org/list', title: 'Scholarships', text: 'lots of awards', links: [] }

// enumerate fakes that mimic extractListingAwardItems' return shape (incl. raw).
const enumWith = (over) => async () => ({ items: [], rejected: [], notFound: [], ...over })

describe('decomposeListing propagates AI-unavailability', () => {
  it('flags a TRANSIENT provider failure (credits/5xx) — unavailable + transient', async () => {
    const out = await decomposeListing(
      { db: {}, profile, listing },
      { enumerate: enumWith({ notFound: ['LLM enumeration call failed: credit balance too low'], raw: { attempted: true, transient: true } }) },
    )
    expect(out.enumerated).toBe(0)
    expect(out.enumeration_unavailable).toBe(true)
    expect(out.enumeration_transient).toBe(true)
  })

  it('flags NO provider configured (attempted:false) — unavailable but not transient', async () => {
    const out = await decomposeListing(
      { db: {}, profile, listing },
      { enumerate: enumWith({ notFound: ['no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY)'], raw: { attempted: false } }) },
    )
    expect(out.enumeration_unavailable).toBe(true)
    expect(out.enumeration_transient).toBe(false)
  })

  it('does NOT flag a genuinely empty page (read succeeded, zero awards)', async () => {
    const out = await decomposeListing(
      { db: {}, profile, listing },
      { enumerate: enumWith({ notFound: ['no individual award opportunities enumerated from the listing text'], raw: { attempted: true, provider: 'anthropic' } }) },
    )
    expect(out.enumerated).toBe(0)
    expect(out.enumeration_unavailable).toBe(false)
    expect(out.enumeration_transient).toBe(false)
  })

  it('does NOT flag a successful enumeration', async () => {
    const insert = async (_db, rec) => ({ id: `opp-${rec.title}`, inserted: true })
    const match = () => ({ decision: 'REVIEW', score: 0.7 })
    const out = await decomposeListing(
      { db: {}, profile, listing },
      {
        enumerate: enumWith({ items: [{ title: 'X Scholarship', applyUrl: null }], raw: { attempted: true, provider: 'openai' } }),
        insert, match,
      },
    )
    expect(out.enumerated).toBe(1)
    expect(out.enumeration_unavailable).toBe(false)
  })
})

describe('describeDecomposition stays honest for an unreadable page', () => {
  it('never claims the page is empty and surfaces the reason', () => {
    const msg = describeDecomposition({
      enumerated: 0,
      admitted: 0,
      notFound: ['LLM enumeration call failed: credit balance too low'],
      rejected: [],
      items: [],
      enumeration_unavailable: true,
      enumeration_transient: true,
    })
    expect(msg).toMatch(/not evidence the page is empty/i)
    expect(msg).toMatch(/credit balance/i)
  })
})
