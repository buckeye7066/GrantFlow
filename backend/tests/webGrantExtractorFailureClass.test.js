/**
 * webGrantExtractorFailureClass.test.js
 *
 * The extractor used to return [] for EVERY failure — thin page, dead LLM key,
 * quota exhaustion, timeout, unparseable answer — so the web lane could not
 * tell "the page lists no funding" from "no provider answered". In production
 * (2026-09-03..09-12) every LLM route was dead and the lane recorded
 * `ok:true extracted:0 reason:null` on ~1,700 crawls, which the coverage audit
 * then classified as recall gaps. These tests pin the failure CLASS the
 * extractor must now surface on its (still array-shaped) return.
 */
import { describe, it, expect } from 'vitest'
import {
  extractOpportunitiesFromPage,
  extractionFailureOf,
  classifyExtractionFailure,
  EXTRACTION_FAILURE_CLASSES,
} from '../services/webGrantExtractor.js'

const RICH_PAGE = `<html><body><main><h1>Community Foundation Grants</h1><p>${'The Bradley County Community Foundation awards grants to nonprofits serving youth. '.repeat(12)}</p><a href="https://example.org/apply">Apply</a></main></body></html>`

describe('webGrantExtractor — failure classes are surfaced, not swallowed', () => {
  it('exports the exact class vocabulary', () => {
    expect(EXTRACTION_FAILURE_CLASSES).toEqual([
      'llm_unavailable', 'llm_quota', 'llm_timeout', 'parse_error', 'page_too_short', 'unknown',
    ])
  })

  it('a thin page is an extraction failure of class page_too_short (still an empty array)', async () => {
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: '<body>hi</body>' }, { openai: null })
    expect(Array.isArray(out)).toBe(true)
    expect(out).toHaveLength(0)
    expect(extractionFailureOf(out)).toMatchObject({ class: 'page_too_short' })
  })

  it('a quota-exhausted provider ladder is llm_quota', async () => {
    const invoke = async () => ({
      ok: false, provider: 'fallback', json: null, timedOut: false,
      openaiError: { status: 429, message: 'insufficient_quota: You exceeded your current quota', isAuth: false },
      anthropicError: '400 credit balance is too low',
      freeRouteErrors: [],
      error: new Error('No AI provider configured or provider failure'),
    })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: RICH_PAGE }, { invoke, openai: {} })
    expect(out).toHaveLength(0)
    expect(extractionFailureOf(out)).toMatchObject({ class: 'llm_quota' })
  })

  it('a timed-out ladder is llm_timeout', async () => {
    const invoke = async () => ({ ok: false, provider: 'fallback', json: null, timedOut: true, openaiError: null, anthropicError: null, freeRouteErrors: [], error: new Error('AI service timed out') })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: RICH_PAGE }, { invoke, openai: {} })
    expect(extractionFailureOf(out)).toMatchObject({ class: 'llm_timeout' })
  })

  it('no provider at all is llm_unavailable', async () => {
    const invoke = async () => ({ ok: false, provider: 'fallback', json: null, timedOut: false, openaiError: null, anthropicError: null, freeRouteErrors: [], error: new Error('No AI provider configured or provider failure') })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: RICH_PAGE }, { invoke, openai: null })
    expect(extractionFailureOf(out)).toMatchObject({ class: 'llm_unavailable' })
  })

  it('a provider that answered without the opportunities array is parse_error', async () => {
    const invoke = async () => ({ ok: true, provider: 'openai', json: { unexpected: true }, raw: '{"unexpected":true}' })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: RICH_PAGE }, { invoke, openai: {} })
    expect(out).toHaveLength(0)
    expect(extractionFailureOf(out)).toMatchObject({ class: 'parse_error' })
  })

  it('a healthy answer that lists no opportunities is NOT a failure (empty, status ok)', async () => {
    const invoke = async () => ({ ok: true, provider: 'openai', json: { opportunities: [] }, raw: '{"opportunities":[]}' })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://example.org/x', html: RICH_PAGE }, { invoke, openai: {} })
    expect(out).toHaveLength(0)
    expect(extractionFailureOf(out)).toBeNull()
    expect(out.extraction_status).toBe('empty')
  })

  it('classifyExtractionFailure is pure and maps provider results + thrown errors', () => {
    expect(classifyExtractionFailure({ ok: false, timedOut: true }).class).toBe('llm_timeout')
    expect(classifyExtractionFailure({ ok: false, aborted: true }).class).toBe('llm_timeout')
    expect(classifyExtractionFailure({ ok: false, openaiError: { status: 429 } }).class).toBe('llm_quota')
    expect(classifyExtractionFailure({ ok: false, anthropicError: 'credit balance is too low' }).class).toBe('llm_quota')
    expect(classifyExtractionFailure({ ok: false, freeRouteErrors: [{ message: '429 rate_limit_exceeded' }] }).class).toBe('llm_quota')
    expect(classifyExtractionFailure({ ok: false }).class).toBe('llm_unavailable')
    expect(classifyExtractionFailure(new Error('llm_timeout')).class).toBe('llm_timeout')
    expect(classifyExtractionFailure(new Error('boom')).class).toBe('unknown')
    expect(classifyExtractionFailure(null).class).toBe('unknown')
  })
})
