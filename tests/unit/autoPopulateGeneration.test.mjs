/**
 * autoPopulateGeneration.test.mjs
 *
 * Regression guard for the 504 Gateway Timeout on POST
 * /api/applications/:id/auto-populate.
 *
 * Root cause: `generateApplicationSections` ran 7-8 OpenAI section calls
 * sequentially with `max_tokens: 2000` and the SDK default 30s × 2 retries
 * per call. Wall time hit 60-180s and the Railway/Vercel proxy returned
 * 504 to the user before the route could respond — every Auto-populate
 * click on /Apply blew up.
 *
 * Fix: parallelize the calls via Promise.allSettled, bound each call to
 * AUTO_POPULATE_PER_SECTION_TIMEOUT_MS, bound the whole batch to
 * AUTO_POPULATE_TOTAL_BUDGET_MS via an AbortController, drop maxRetries
 * to 0, and let any section that doesn't return in time fall back to
 * empty content (auto-populate is a "seed the draft" feature, never a
 * hard-fail surface).
 *
 * This test exercises the fix directly with a fake openai client so the
 * fan-out / timeout / abort behavior is locked in independently of the
 * real OpenAI service.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { generateApplicationSections } from '../../backend/apply/applyEngine.js'

const SECTIONS = [
  { section_key: 'cover_letter', title: 'Cover Letter' },
  { section_key: 'needs_statement', title: 'Statement of Need' },
  { section_key: 'project_narrative', title: 'Project Narrative' },
  { section_key: 'budget_justification', title: 'Budget Justification' },
  { section_key: 'organization_background', title: 'Applicant Background' },
  { section_key: 'evaluation_plan', title: 'Evaluation Plan' },
  { section_key: 'submission_instructions', title: 'Submission Instructions' },
]

function makeFakeOpenAI({ perCallMs = 50, failTitles = new Set(), hangTitles = new Set() } = {}) {
  return {
    chat: {
      completions: {
        create: (body, opts = {}) => {
          // Identify the section by inspecting the prompt content. The prompt
          // template starts with `Write the "<Title>" section …`, so matching
          // on the human title is the most stable signal.
          const userMsg = (body?.messages || []).find((m) => m.role === 'user')
          const promptText = String(userMsg?.content || '')
          const hangSection = [...hangTitles].find((t) => promptText.includes(`"${t}"`))
          const failSection = [...failTitles].find((t) => promptText.includes(`"${t}"`))
          return new Promise((resolve, reject) => {
            const onAbort = () => {
              const err = new Error('Request was aborted.')
              err.name = 'AbortError'
              reject(err)
            }
            if (opts.signal?.aborted) return onAbort()
            opts.signal?.addEventListener?.('abort', onAbort, { once: true })

            if (failSection) {
              setTimeout(() => reject(new Error(`forced failure for ${failSection}`)), 5)
              return
            }

            // Hang means we never resolve — only the abort signal can finish us.
            if (hangSection) return

            setTimeout(() => {
              opts.signal?.removeEventListener?.('abort', onAbort)
              resolve({
                choices: [{ message: { content: `draft for ${promptText.slice(0, 40)}` } }],
              })
            }, perCallMs)
          })
        },
      },
    },
  }
}

const fakeGrant = {
  id: 'g-test',
  title: 'Test Grant',
  funder: 'Test Funder',
  profile_id: 'p-test',
}
const fakeOpportunity = { id: 'o-test', sponsor: 'Test Sponsor' }
const fakeProfile = { id: 'p-test', display_name: 'Test Applicant' }
const fakeDb = { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) }

test('generateApplicationSections runs sections in parallel, not sequentially', async () => {
  const perCallMs = 200
  const fake = makeFakeOpenAI({ perCallMs })
  const startedAt = Date.now()
  const result = await generateApplicationSections(
    fakeDb,
    fakeGrant,
    fakeOpportunity,
    fakeProfile,
    SECTIONS,
    { openaiOverride: fake, totalBudgetMs: 10_000 },
  )
  const elapsed = Date.now() - startedAt

  // Every section should have produced content.
  for (const s of SECTIONS) {
    assert.ok(
      typeof result[s.section_key] === 'string' && result[s.section_key].length > 0,
      `expected content for ${s.section_key}, got ${JSON.stringify(result[s.section_key])}`,
    )
  }
  // Sequential would be 7 * 200ms = 1400ms. Parallel must be < 3 * perCallMs to
  // catch a regression that turns the fan-out back into a serial loop. 600ms
  // gives a comfortable cushion for slow CI without hiding a real regression.
  assert.ok(
    elapsed < 3 * perCallMs,
    `expected parallel fan-out (< ${3 * perCallMs}ms) but took ${elapsed}ms — likely regressed to a serial loop`,
  )
})

test('generateApplicationSections: a single failing section does not block the rest', async () => {
  const fake = makeFakeOpenAI({ perCallMs: 30, failTitles: new Set(['Cover Letter']) })
  const result = await generateApplicationSections(
    fakeDb,
    fakeGrant,
    fakeOpportunity,
    fakeProfile,
    SECTIONS,
    { openaiOverride: fake, totalBudgetMs: 5_000 },
  )

  assert.equal(result.cover_letter, '', 'failed section should fall back to empty string, not throw')
  for (const s of SECTIONS.filter((x) => x.section_key !== 'cover_letter')) {
    assert.ok(
      typeof result[s.section_key] === 'string' && result[s.section_key].length > 0,
      `other sections should still complete; ${s.section_key} did not`,
    )
  }
})

test('generateApplicationSections: hung section is aborted by the wall-clock budget', async () => {
  const fake = makeFakeOpenAI({ perCallMs: 30, hangTitles: new Set(['Project Narrative']) })
  const startedAt = Date.now()
  const result = await generateApplicationSections(
    fakeDb,
    fakeGrant,
    fakeOpportunity,
    fakeProfile,
    SECTIONS,
    { openaiOverride: fake, totalBudgetMs: 400 },
  )
  const elapsed = Date.now() - startedAt

  assert.equal(result.project_narrative, '', 'hung section should be aborted and return empty string')
  // The wall budget must not be wildly exceeded — the request must finish even
  // when a single section hangs. We give the cleanup path a small buffer.
  assert.ok(
    elapsed < 2_000,
    `auto-populate must finish within the wall-clock budget; elapsed=${elapsed}ms`,
  )
  // The non-hung sections should still have produced content.
  const otherSections = SECTIONS.filter((x) => x.section_key !== 'project_narrative')
  const okCount = otherSections.filter((s) => result[s.section_key]?.length > 0).length
  assert.ok(
    okCount === otherSections.length,
    `non-hung sections should complete; got ${okCount}/${otherSections.length}`,
  )
})
