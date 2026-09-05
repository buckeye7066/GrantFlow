import { describe, it, expect, afterEach, vi } from 'vitest'
import { adminCodeScan } from '../services/anyaAdminTools.js'
import { runDiagnostics } from '../services/sam/samDiagnostics.js'
import { DIAGNOSTIC_CHECKS } from '../services/sam/samRegistry.js'

/**
 * Sam's "codebase scan" check (TODO / FIXME / HACK / console / debugger).
 *
 * The owner's report was: "Sam's code sweep is a placeholder. He does not
 * actually sweep code, the whole code."
 *
 * Three separate things made that true, and this file pins the fix for each:
 *
 *  1. COVERAGE. The loop was `files.slice(0, 200)` against 1,967 files under
 *     backend/ alone, and the response carried no discovered/scanned split and
 *     no truncation flag — so "0 debugger statements" read as a claim about the
 *     repository. Measured on this repo at the 200-file cap: 75 issues from 200
 *     files; uncapped: 2,141 from 1,967. Same number, two different worlds.
 *  2. THE FILE PATTERN. `filePattern` was echoed back in the response and never
 *     applied to anything.
 *  3. THE FINDINGS NEVER REACHED SAM. `samDiagnostics.pickList()` mines
 *     `result.findings` only when it is an ARRAY; this tool returns an OBJECT
 *     keyed by issue type, so every scan contributed ZERO findings to Sam's
 *     report regardless of what it found. That is why the last test here drives
 *     the REAL `runDiagnostics` path rather than asserting on a shape.
 */

const TARGET = 'backend/services/sam'
const originalMax = process.env.SAM_SCAN_MAX_FILES
afterEach(() => {
  if (originalMax === undefined) delete process.env.SAM_SCAN_MAX_FILES
  else process.env.SAM_SCAN_MAX_FILES = originalMax
})

const ADMIN = { user: { isAdmin: true } }

describe('coverage is reported honestly', () => {
  it('reports files DISCOVERED and files SCANNED as separate numbers', async () => {
    const result = await adminCodeScan({ directory: TARGET }, ADMIN)
    expect(typeof result.files_discovered).toBe('number')
    expect(typeof result.files_scanned).toBe('number')
    expect(result.files_discovered).toBeGreaterThan(0)
    expect(result.files_scanned).toBeLessThanOrEqual(result.files_discovered)
    expect(result.summary.coverage_note).toMatch(/Scanned \d+ of the \d+ matching files/)
  })

  /**
   * The load-bearing one. The old code scanned 200 files and reported the
   * result as if it had read the tree.
   */
  it('SAYS SO when it scanned less than it found', async () => {
    process.env.SAM_SCAN_MAX_FILES = '1'
    const result = await adminCodeScan({ directory: TARGET }, ADMIN)
    expect(result.files_discovered).toBeGreaterThan(1)
    expect(result.files_scanned).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.summary.coverage_note).toMatch(/TRUNCATED/)
    // and the truncation is not merely a field — it leaves the tool as an issue
    expect(result.issues.some((i) => /TRUNCATED/i.test(i.title))).toBe(true)
  })

  it('does not claim truncation when it covered everything', async () => {
    process.env.SAM_SCAN_MAX_FILES = '100000'
    const result = await adminCodeScan({ directory: TARGET }, ADMIN)
    expect(result.truncated).toBe(false)
    expect(result.files_scanned + result.files_unreadable).toBe(result.files_matching_pattern)
    expect(result.issues.some((i) => /TRUNCATED/i.test(i.title))).toBe(false)
  })

  it('scans the WHOLE backend tree by default, not the first 200 files', async () => {
    const result = await adminCodeScan({ directory: 'backend' }, ADMIN)
    expect(result.files_scanned).toBeGreaterThan(1000)
    expect(result.truncated).toBe(false)
  }, 120_000)
})

describe('the file pattern is applied, not just echoed', () => {
  it('scans only the files the caller asked for', async () => {
    const all = await adminCodeScan({ directory: TARGET, filePattern: '*' }, ADMIN)
    const subset = await adminCodeScan({ directory: TARGET, filePattern: 'samA*.js' }, ADMIN)

    expect(subset.files_discovered).toBe(all.files_discovered)
    expect(subset.files_matching_pattern).toBeGreaterThan(0)
    expect(subset.files_matching_pattern).toBeLessThan(all.files_matching_pattern)
    expect(subset.files_scanned).toBe(subset.files_matching_pattern)

    // Nothing outside the pattern may appear in the findings.
    const files = Object.values(subset.findings).flat().map((f) => f.file)
    for (const file of files) expect(file).toMatch(/[\\/]samA[^\\/]*\.js$/)
  })

  it('a pattern that matches nothing reports zero scanned — it does not fall back to the tree', async () => {
    const result = await adminCodeScan({ directory: TARGET, filePattern: '*.nomatch' }, ADMIN)
    expect(result.files_discovered).toBeGreaterThan(0)
    expect(result.files_matching_pattern).toBe(0)
    expect(result.files_scanned).toBe(0)
    expect(result.issues_found).toBe(0)
  })
})

describe('an issue class that was never looked for is not reported as clean', () => {
  it('omits unscanned classes from findings and NAMES them', async () => {
    const result = await adminCodeScan({ directory: TARGET, issueTypes: ['debugger'] }, ADMIN)
    expect(result.issue_types_scanned).toEqual(['debugger'])
    expect(result.issue_types_not_scanned).toEqual(expect.arrayContaining(['todo', 'console', 'fixme', 'hack']))
    // An empty `hack_items: []` here would read as "there are no HACK comments",
    // when the truth is that nothing looked.
    expect(result.findings).not.toHaveProperty('hack_items')
    expect(result.findings).toHaveProperty('debugger_statements')
  })

  it('scans every class by default', async () => {
    const result = await adminCodeScan({ directory: TARGET }, ADMIN)
    expect(result.issue_types_scanned).toEqual(['todo', 'console', 'debugger', 'fixme', 'hack'])
    expect(result.issue_types_not_scanned).toEqual([])
  })
})

describe('what the scan finds actually reaches Sam', () => {
  /**
   * Drives the REAL Sam diagnostic path (runDiagnostics -> runToolCheck ->
   * mineToolFindings -> pickList) with the REAL scanner behind the dispatcher.
   * Under the old return shape this produced an empty findings array no matter
   * what the scan found, because pickList only mines an ARRAY.
   */
  it('produces Sam findings from a real scan', async () => {
    const invokeTool = vi.fn(async (_db, user, tool) => {
      expect(tool).toBe('admin.code.scan')
      return adminCodeScan({ directory: TARGET }, { user })
    })

    const { findings, results } = await runDiagnostics({
      db: null,
      ctx: null,
      checkIds: ['code.scan'],
      invokeTool,
    })

    expect(invokeTool).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({ check_id: 'code.scan', ok: true })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.title)).toBe(true)
  })

  it('surfaces a truncated sweep to Sam as a finding of its own', async () => {
    process.env.SAM_SCAN_MAX_FILES = '1'
    const invokeTool = vi.fn(async (_db, user) => adminCodeScan({ directory: TARGET }, { user }))

    const { findings } = await runDiagnostics({
      db: null,
      ctx: null,
      checkIds: ['code.scan'],
      invokeTool,
    })

    expect(findings.some((f) => /TRUNCATED/i.test(f.title))).toBe(true)
  })

  it('the registry no longer describes a coverage it does not report', () => {
    const check = DIAGNOSTIC_CHECKS.find((c) => c.tool === 'admin.code.scan')
    expect(check, 'the code.scan check must still exist').toBeTruthy()
    expect(check.description).toMatch(/files_discovered vs files_scanned|truncated/i)
  })
})
