/**
 * Unit tests for queryRelevance.js — the single definition of "does this
 * result answer the query?", shared by searxngProvider's per-result ranking
 * and webSearchEngine's per-SERP degeneracy gate.
 *
 * The live junk these encode was measured against the production SearXNG
 * instance on 2026-07-31 across 8 profile-shaped queries: 46.9% of the
 * returned top-8 covered only the query's leading token ("Ohio - Wikipedia",
 * "Texas Maps & Facts", "THE 15 BEST Things to Do in Memphis") while the real
 * funders sat deeper in the same 30+ result pool.
 */

import { describe, it, expect } from 'vitest'
import {
  distinctiveTerms,
  coveredTerms,
  isWeakResult,
  partitionByRelevance,
} from '../services/shared/queryRelevance.js'

describe('distinctiveTerms', () => {
  it('drops stopwords, short tokens and bare numbers, preserving order', () => {
    expect(distinctiveTerms('Tennessee disability housing grants')).toEqual([
      'tennessee', 'disability', 'housing',
    ])
    // "grants"/"funding" are stopwords; "for"/"the" too short AND stopwords.
    expect(distinctiveTerms('funding for the 2026 Ohio robotics program')).toEqual([
      'ohio', 'robotics',
    ])
  })

  it('returns an empty list when the query is only generic funding words', () => {
    expect(distinctiveTerms('grants and funding assistance')).toEqual([])
  })
})

describe('coveredTerms', () => {
  it('matches on whole words across url, title and snippet', () => {
    const terms = distinctiveTerms('Wisconsin early childhood learning center funding')
    const r = { url: 'https://wisconsinearlychildhood.org', title: 'Wisconsin Early Childhood Association', snippet: '' }
    expect(coveredTerms(r, terms)).toEqual(expect.arrayContaining(['wisconsin', 'early', 'childhood']))
  })

  it('does NOT count a term found only as a substring', () => {
    // 'west' must not be covered by 'western' — this exact substring bug let a
    // University-of-West-Florida junk SERP through the gate (live 2026-07-27).
    expect(coveredTerms({ title: 'western United States' }, ['west'])).toEqual([])
  })
})

describe('isWeakResult — the first-word-collapse signature', () => {
  const Q = 'Ohio robotics education nonprofit grants'

  it('flags a result covering ONLY the query first term', () => {
    expect(isWeakResult(Q, { url: 'https://en.wikipedia.org/wiki/Ohio', title: 'Ohio - Wikipedia', snippet: '' })).toBe(true)
    expect(isWeakResult(Q, { url: 'https://ohio.gov', title: 'Ohio.gov | Official Website of the State of Ohio', snippet: '' })).toBe(true)
  })

  it('flags a result covering NO distinctive term', () => {
    expect(isWeakResult(Q, { url: 'https://grants.gov', title: 'Home | Grants.gov', snippet: '' })).toBe(true)
  })

  it('keeps a result that answers the actual question', () => {
    expect(isWeakResult(Q, {
      url: 'https://roboticseducation.org',
      title: 'Robotics Education & Competition Foundation',
      snippet: 'nonprofit',
    })).toBe(false)
  })

  it('keeps a result covering the first term PLUS any other term', () => {
    expect(isWeakResult(Q, { url: 'https://x.org', title: 'Ohio robotics teams', snippet: '' })).toBe(false)
  })

  it('never flags anything when the query has fewer than 2 distinctive terms', () => {
    // Nothing to discriminate on — filtering here would be guesswork, and it
    // mirrors looksDegenerateSerp's identical guard so the two rules agree.
    expect(isWeakResult('scholarships', { url: 'https://anything.example', title: 'x', snippet: '' })).toBe(false)
    expect(isWeakResult('Ohio grants', { url: 'https://en.wikipedia.org/wiki/Ohio', title: 'Ohio - Wikipedia', snippet: '' })).toBe(false)
  })
})

describe('partitionByRelevance', () => {
  const Q = 'Tennessee disability housing grants'
  const JUNK_A = { url: 'https://en.wikipedia.org/wiki/Tennessee', title: 'Tennessee - Wikipedia', snippet: '' }
  const JUNK_B = { url: 'https://tnvacation.com', title: '20 Best Places to Visit in Tennessee', snippet: '' }
  const GOOD_A = { url: 'https://tndisability.org/programs/small-grants/', title: 'Small Grants | Tennessee Disability Coalition', snippet: '' }
  const GOOD_B = { url: 'https://thda.org/tennessee-housing-trust-fund', title: 'Tennessee Housing Trust Fund', snippet: '' }

  it('separates strong from weak and preserves order within each group', () => {
    const { strong, weak } = partitionByRelevance(Q, [JUNK_A, GOOD_A, JUNK_B, GOOD_B])
    expect(strong).toEqual([GOOD_A, GOOD_B])
    expect(weak).toEqual([JUNK_A, JUNK_B])
  })

  it('loses nothing — strong + weak always re-forms the whole input', () => {
    const input = [JUNK_A, GOOD_A, JUNK_B, GOOD_B]
    const { strong, weak } = partitionByRelevance(Q, input)
    expect([...strong, ...weak]).toHaveLength(input.length)
    for (const r of input) expect([...strong, ...weak]).toContain(r)
  })

  it('puts everything in weak when no result answers the query', () => {
    const { strong, weak } = partitionByRelevance(Q, [JUNK_A, JUNK_B])
    expect(strong).toEqual([])
    expect(weak).toEqual([JUNK_A, JUNK_B])
  })

  it('tolerates a non-array input', () => {
    expect(partitionByRelevance(Q, null)).toEqual({ strong: [], weak: [] })
  })
})
