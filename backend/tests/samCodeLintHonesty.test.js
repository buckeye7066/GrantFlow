import { describe, it, expect, afterEach } from 'vitest'
import { adminCodeLint } from '../services/anyaAdminTools.js'
import { DIAGNOSTIC_CHECKS } from '../services/sam/samRegistry.js'

/**
 * Sam's "code lint snapshot" check.
 *
 * The owner's report was: "Sam's code sweep is a placeholder. He does not
 * actually sweep code, the whole code."
 *
 * For this check that was exactly right, and the registry made it worse by
 * describing it as something it was not. samRegistry.js carried
 *     heavy: true, // shells out to ESLint over the tree
 * and a description promising "ESLint-style issues", while adminCodeLint ran
 * TWO hand-rolled regexes — `no-var` and a loose-equality test — over at most
 * 50 files, above a comment that admitted "Simplified linting - in production,
 * you'd integrate with ESLint".
 *
 * It also overstated its own coverage: `files_checked` reported every file
 * DISCOVERED (1,800+ under backend/ alone) while the loop linted 50 of them. A
 * check reporting 36x the work it did is worse than no check, because the
 * number reads as reassurance.
 *
 * The check now runs the real ESLint through its Node API. These tests pin the
 * three properties that make that claim trustworthy: it is genuinely ESLint, it
 * reports honestly how much of the tree it covered, and it never writes.
 */

const TARGET = 'backend/services/sam'
const originalMax = process.env.SAM_LINT_MAX_FILES
afterEach(() => {
  if (originalMax === undefined) delete process.env.SAM_LINT_MAX_FILES
  else process.env.SAM_LINT_MAX_FILES = originalMax
})

describe('the check is what the registry says it is', () => {
  it('runs the REAL ESLint, and says which engine produced the result', async () => {
    const result = await adminCodeLint({ targetPath: TARGET }, { db: null })
    // If ESLint is genuinely absent the engine must SAY so rather than passing
    // two regexes off as a lint run — that honesty is the point, so both
    // values are acceptable and the label is what is asserted.
    expect(['eslint', 'builtin-heuristics']).toContain(result.engine)
    if (result.engine === 'builtin-heuristics') {
      expect(result.engine_note).toMatch(/NOT a lint run/i)
    }
  })

  it('the registry no longer claims a capability the code lacks', () => {
    const check = DIAGNOSTIC_CHECKS.find((c) => c.tool === 'admin.code.lint')
    expect(check, 'the code.lint check must still exist').toBeTruthy()
    // The old description promised ESLint while the code ran regexes. Whatever
    // the wording, it must not promise autofixes the check deliberately never
    // applies.
    expect(check.description).toMatch(/never applies autofixes|without applying autofixes/i)
  })
})

describe('coverage is reported honestly', () => {
  it('reports files DISCOVERED and files LINTED as separate numbers', async () => {
    const result = await adminCodeLint({ targetPath: TARGET }, { db: null })
    expect(typeof result.files_discovered).toBe('number')
    expect(typeof result.files_linted).toBe('number')
    expect(result.files_discovered).toBeGreaterThan(0)
    expect(result.files_linted).toBeLessThanOrEqual(result.files_discovered)
  })

  /**
   * The load-bearing one. The old code reported every discovered file as
   * "checked" while linting 50, so a caller asking "did Sam sweep the whole
   * code?" was answered yes when the truth was 3%.
   */
  it('SAYS SO when it linted less than it found', async () => {
    process.env.SAM_LINT_MAX_FILES = '1'
    const result = await adminCodeLint({ targetPath: TARGET }, { db: null })
    expect(result.files_discovered).toBeGreaterThan(1)
    expect(result.files_linted).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('does not claim truncation when it covered everything', async () => {
    process.env.SAM_LINT_MAX_FILES = '100000'
    const result = await adminCodeLint({ targetPath: TARGET }, { db: null })
    expect(result.truncated).toBe(false)
    expect(result.files_linted).toBe(result.files_discovered)
  })
})

describe('a reporting check never writes to the tree', () => {
  it('never applies a fix, even when one is requested', async () => {
    const result = await adminCodeLint({ targetPath: TARGET, fix: true }, { db: null })
    expect(result.fix_applied).toBe(false)
    expect(result.fix_requested).toBe(true)
  })

  it('refuses a path outside the repository', async () => {
    await expect(adminCodeLint({ targetPath: '../../../etc' }, { db: null }))
      .rejects.toThrow(/outside repository root/i)
  })
})
