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

import { generateApplicationSections, buildDefaultSectionsForStyle } from '../../backend/apply/applyEngine.js'

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

test('generateApplicationSections: every LLM prompt carries the ORG profile facts AND the funder\'s own program facts', async () => {
  // Owner rule: proposals are "tailored to the funding source with the
  // information from the appropriate profile written at an MBA level" — for
  // ORG profiles (church/ministry) as much as for students. This pins the
  // WIRING: every generated section's prompt must contain (a) this org's own
  // profile facts and (b) this funder's own stated program facts, so a draft
  // for funder A can argue alignment with A's program instead of boilerplate.
  const capturedPrompts = []
  let capturedSystem = null
  const capturingOpenAI = {
    chat: {
      completions: {
        create: async (body) => {
          const sys = (body?.messages || []).find((m) => m.role === 'system')
          const user = (body?.messages || []).find((m) => m.role === 'user')
          capturedSystem = String(sys?.content || '')
          capturedPrompts.push(String(user?.content || ''))
          return { choices: [{ message: { content: 'draft' } }] }
        },
      },
    },
  }

  const orgGrant = {
    id: 'g-org',
    title: 'Community Facilities Improvement Grant',
    funder: 'Sacred Places Preservation Fund',
    profile_id: 'p-org',
  }
  const orgOpportunity = {
    id: 'o-org',
    sponsor: 'Sacred Places Preservation Fund',
    description: 'Capital grants for repairing historic community-serving religious buildings.',
    eligibility_text: 'Congregations must demonstrate active community programming open to non-members.',
    categories: JSON.stringify(['historic_preservation', 'community_facilities']),
    amount_min: 5000,
    amount_max: 50000,
  }
  const orgProfile = {
    id: 'p-org',
    display_name: 'Focus Forward Ministry',
    primary_type: 'ministry',
    state: 'OH',
    sections: {
      organization_information: { organization_name: 'Focus Forward Ministry', year_founded: 1998 },
      narrative: { mission: 'Deliver building supplies and repairs to under-resourced neighbors' },
      programs_services: { focus_areas: ['Building supplies', 'Home repair assistance'] },
    },
  }

  const sectionDefs = buildDefaultSectionsForStyle('standard').filter(
    (s) => s.section_key !== 'submission_instructions' && s.section_key !== 'medical_necessity',
  )
  const result = await generateApplicationSections(
    fakeDb, orgGrant, orgOpportunity, orgProfile, sectionDefs,
    { openaiOverride: capturingOpenAI, totalBudgetMs: 10_000 },
  )

  assert.equal(capturedPrompts.length, sectionDefs.length, 'every LLM section must produce one prompt')
  for (const s of sectionDefs) {
    assert.ok(result[s.section_key], `${s.section_key} must produce content`)
  }
  for (const prompt of capturedPrompts) {
    // (a) the org's own profile facts
    assert.match(prompt, /Focus Forward Ministry/, 'org name must reach the prompt')
    assert.match(prompt, /building supplies/i, 'org mission/programs must reach the prompt')
    // (b) the funder's own stated program facts
    assert.match(prompt, /Sacred Places Preservation Fund/, 'funder name must reach the prompt')
    assert.match(prompt, /historic community-serving religious buildings/, "funder's program description must reach the prompt")
    assert.match(prompt, /active community programming open to non-members/, "funder's stated eligibility must reach the prompt")
    assert.match(prompt, /historic_preservation/, "funder's focus areas must reach the prompt")
    assert.match(prompt, /5000\s*-\s*\$50000|5000.*50000/, "funder's stated award range must reach the prompt")
  }
  // MBA register + per-funder tailoring rule live in the ONE system prompt and
  // must not be overridden by a generic tone instruction.
  assert.match(capturedSystem, /MBA/, 'system prompt must carry the MBA register')
  assert.match(capturedSystem, /TAILOR TO THE FUNDER/, 'system prompt must carry the tailoring rule')
  assert.match(capturedSystem, /\[review: confirm funder priority\]/, 'honest placeholder rule must be present')
})

test('generateApplicationSections: buildDefaultSectionsForStyle import sanity', () => {
  // The test above filters the standard shape; keep a tripwire that the shape
  // still holds the seven org sections it filters from.
  const keys = buildDefaultSectionsForStyle('standard').map((s) => s.section_key)
  assert.equal(keys.length, 7)
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
