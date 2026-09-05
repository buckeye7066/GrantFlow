import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { adminCodeCrawl } from '../services/anyaAdminTools.js'

/**
 * Sam's "codebase pattern crawl" (admin.code.crawl).
 *
 * The owner's report — "Sam's code sweep is a placeholder. He does not actually
 * sweep code, the whole code" — was about the SCAN, but the CRAWL beside it had
 * the same shape from the other direction: it read far too much of the wrong
 * thing and silently skipped real source.
 *
 *  1. IT WALKED OTHER AGENTS' WORKTREES. This walk had no dot-directory rule
 *     (its sibling `collectFiles` in the same file always had one), so it
 *     descended into `.claude/worktrees/` — throwaway checkouts other agents
 *     leave behind — and read 82,299 files there against 2,344 in the actual
 *     working tree: 97.2% of the crawl. Findings could cite paths that are not
 *     this repository, and `bytes_scanned` was inflated ~36x.
 *
 *  2. THE IGNORE LIST WAS A SUBSTRING TEST. `relativePath.includes(p)` — the
 *     same defect CLAUDE.md documents for the SQL guard (`updated_at` ⊃
 *     *update*). Measured on this repo it never read 52 real source files,
 *     including ALL of backend/services/coverageAudit/ ("coverage"),
 *     hamiltonAttestationStore.js ("test" inside "Attestation") and
 *     scripts/score-distribution.mjs ("dist" inside "distribution") — while
 *     `coverage.complete` reported TRUE, because those files were never
 *     unreadable, they were never visited.
 */

const ADMIN = { user: { isAdmin: true } }
const rel = (p) => p.split(/[\\/]/).join(path.sep)

const SOURCE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const TEST_FILE_RX = /\.(test|spec)\.[cm]?[jt]sx?$/i

/** Count the source files the crawl SHOULD read under `dir` (includeTests: false). */
async function countSourceFiles(dir) {
  let entries = []
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return 0 }
  let total = 0
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue
      if (['node_modules', 'dist', 'build', 'coverage', 'out', 'vendor', 'test', 'tests', '__tests__'].includes(entry.name)) continue
      total += await countSourceFiles(path.join(dir, entry.name))
      continue
    }
    if (!entry.isFile()) continue
    if (!SOURCE_EXT.has(path.extname(entry.name))) continue
    if (TEST_FILE_RX.test(entry.name)) continue
    total += 1
  }
  return total
}

describe('the crawl reads THIS repository, not other agents\' worktrees', () => {
  /**
   * The load-bearing scope test. A whole-repo crawl must read the working tree
   * and nothing else. Measured on this machine: the real tree holds ~2,300
   * source files; with the dot-directory rule removed the same walk reaches
   * 84,643 (82,299 of them inside `.claude/worktrees/`) and a whole-repo pass
   * did not finish in 22 minutes, against a 60s per-check budget — so the
   * check would report an INFO "skipped" note and lose its findings.
   */
  it('a whole-repo crawl reads the working tree only, and finishes', async () => {
    const result = await adminCodeCrawl({ includeTests: false }, ADMIN)

    expect(result.coverage.source_files_scanned).toBeGreaterThan(1000)
    expect(result.coverage.source_files_scanned).toBeLessThan(10_000)
    expect(result.coverage.excluded_directory_names).toContain('node_modules')

    for (const finding of result.findings) {
      const firstSegment = String(finding.file || '').split(/[\\/]/)[0]
      expect(firstSegment.startsWith('.'), `dot-dir path leaked into a finding: ${finding.file}`).toBe(false)
    }
  }, 300_000)

  it('excludes dot-directories by NAME and says which ones it excluded', async () => {
    const result = await adminCodeCrawl({ directory: 'backend' }, ADMIN)
    expect(result.coverage.directories_excluded).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(result.coverage.excluded_directory_names)).toBe(true)
    expect(result.coverage.exclusion_rule).toMatch(/SEGMENT/)
  }, 180_000)
})

describe('an ignore pattern matches a path SEGMENT, never a substring', () => {
  /**
   * The load-bearing one. Every file below is production source whose PATH
   * merely contains the letters of an ignore pattern.
   */
  it('reads source files whose names contain "coverage", "test", "dist" or "build"', async () => {
    const result = await adminCodeCrawl({ directory: 'backend/services/coverageAudit' }, ADMIN)
    // The whole directory used to be unreachable: its path contains "coverage".
    expect(result.coverage.source_files_scanned).toBeGreaterThan(3)
    expect(result.coverage.complete).toBe(true)
  }, 120_000)

  it('reads a production file whose NAME contains a pattern ("Attestation" ⊃ test)', async () => {
    const result = await adminCodeCrawl({
      directory: 'backend/services/hamilton',
      pattern: 'assessStoredConfirmationProof|hamiltonAttestation',
    }, ADMIN)
    expect(result.coverage.source_files_scanned).toBeGreaterThan(10)
    // Nothing under this directory is a real test path, so none may be skipped
    // for being one.
    expect(result.coverage.excluded_directory_names).not.toContain('hamilton')
  }, 180_000)

  it('STILL excludes a genuine tests directory when includeTests is false', async () => {
    const result = await adminCodeCrawl({ directory: 'backend' }, ADMIN)
    for (const finding of result.findings) {
      expect(finding.file.split(/[\\/]/), `a real test path leaked: ${finding.file}`).not.toContain('tests')
    }
    expect(result.coverage.tests_included).toBe(false)
  }, 180_000)

  it('includes them when the caller asks for tests', async () => {
    const withTests = await adminCodeCrawl({ directory: 'backend/services/sam', includeTests: true }, ADMIN)
    const withoutTests = await adminCodeCrawl({ directory: 'backend/services/sam', includeTests: false }, ADMIN)
    expect(withTests.coverage.tests_included).toBe(true)
    expect(withTests.coverage.source_files_scanned).toBeGreaterThanOrEqual(withoutTests.coverage.source_files_scanned)
  }, 120_000)
})

describe('coverage is reported honestly beside what it declined to visit', () => {
  it('reports deliberate exclusions, not only read failures', async () => {
    const result = await adminCodeCrawl({ directory: 'backend' }, ADMIN)
    expect(typeof result.coverage.directories_excluded).toBe('number')
    expect(typeof result.coverage.tests_included).toBe('boolean')
    expect(result.coverage).toHaveProperty('exclusion_rule')
    // complete still means "nothing failed to read"
    expect(result.coverage.complete).toBe(result.coverage.unreadable_count === 0)
  }, 180_000)

  /**
   * A named, checkable instance rather than a generic assertion.
   * `backend/scripts/score-distribution.mjs` is production tooling that carries
   * 12 `console.log` calls, and its path contains the letters "dist". Under the
   * substring rule the walk never opened it, so not one of those 12 could ever
   * be reported.
   */
  it('reads EVERY source file in backend/scripts — the walk is total for a real directory', async () => {
    // Counted from the filesystem with the crawl's own rules, so this cannot
    // drift as scripts are added. Under the substring rule this directory lost
    // score-distribution.mjs ("dist" inside "distribution", 12 console.log
    // calls that could never be reported), source-coverage-report.mjs and
    // populate-geo-coverage.mjs ("coverage"), run-full-system-test.mjs and
    // test-geo-crawl.mjs ("test").
    const expected = await countSourceFiles(path.join(process.cwd(), 'backend', 'scripts'))
    const result = await adminCodeCrawl({ directory: 'backend/scripts' }, ADMIN)
    expect(result.coverage.source_files_scanned).toBe(expected)
    expect(result.coverage.unreadable_count).toBe(0)
  }, 180_000)
})
