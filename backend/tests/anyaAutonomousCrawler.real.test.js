import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { runAutonomousCodeCrawl } from '../services/anyaAutonomousCrawler.js'

// These tests prove the autonomous audit returns real, traceable metrics.
// Each counter must correspond to a real file-system action or regex match.

let tmpDir
let originalCwd

const mockContext = { db: null, user: { id: 'test-admin', role: 'admin' } }

async function seed(file, content) {
  const abs = path.join(tmpDir, file)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  return abs
}

describe('anyaAutonomousCrawler: real metrics, no hallucinated counts', () => {
  beforeAll(async () => {
    originalCwd = process.cwd()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anya-audit-'))
    process.chdir(tmpDir)

    await seed('src/clean.js', 'export function add(a, b) { return a + b }\n')
    await seed(
      'src/silent.js',
      [
        'export function risky() {',
        '  try { doStuff() }',
        '  catch (err) {}',
        '}',
        '',
      ].join('\n'),
    )
    await seed(
      'src/mock.js',
      [
        "const mockData = [1, 2, 3]",
        "// TODO: replace mockData with real source",
        'export default mockData',
        '',
      ].join('\n'),
    )
    await seed(
      'src/console.js',
      [
        "console.log('hi')",
        "export const x = 1",
        '',
      ].join('\n'),
    )
  })

  afterAll(async () => {
    process.chdir(originalCwd)
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('files_scanned counts only walked files (not fabricated)', async () => {
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    expect(report.files_scanned).toBe(4)
    expect(report.files_analyzed).toBe(4)
  })

  it('issues_found matches per-file issue totals exactly (no inflation)', async () => {
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    const summedFromFiles = report.issue_summary_by_file.reduce((acc, f) => acc + f.issueCount, 0)
    expect(report.issues_found).toBe(summedFromFiles)
    expect(report.issues_found).toBeGreaterThan(0)
  })

  it('dry-run never modifies files on disk, issues_fixed reflects only applied fixes', async () => {
    const before = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    const after = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
    expect(after).toBe(before)
    expect(report.dry_run).toBe(true)

    const totalReported = report.modifications.reduce((acc, m) => acc + m.changes_count, 0)
    expect(report.issues_fixed).toBe(totalReported)
  })

  it('each modification has a real diff, before/after SHA1, and matching changes_count', async () => {
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    for (const m of report.modifications) {
      expect(typeof m.diff).toBe('string')
      expect(m.diff.length).toBeGreaterThan(0)
      expect(m.before_sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(m.after_sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(m.before_sha1).not.toBe(m.after_sha1)
      expect(m.changes_count).toBe(m.fixes_applied.length)
    }
  })

  it('detects real patterns: silent catch, mock data, todo, console.log', async () => {
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    const types = new Set(report.issue_summary_by_type.map((s) => s.type))
    expect(types.has('silent_catch')).toBe(true)
    expect(types.has('mock_data')).toBe(true)
    expect(types.has('todo_fixme')).toBe(true)
    expect(types.has('console_noise')).toBe(true)
  })

  it('writes a persistent JSON audit report to disk', async () => {
    const report = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    expect(report.report_path).toBeTruthy()
    const absReport = path.join(tmpDir, report.report_path)
    const raw = await fs.readFile(absReport, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.files_scanned).toBe(report.files_scanned)
    expect(parsed.issues_found).toBe(report.issues_found)
  })

  it('apply mode (write enabled) actually modifies silent catch and issues_fixed === applied fixes', async () => {
    process.env.ANYA_AUTONOMOUS_WRITE_CHANGES = 'true'
    try {
      const before = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
      expect(before).toMatch(/catch \(err\) \{\}/)

      const report = await runAutonomousCodeCrawl(
        { dryRun: false, fixEmptyCatch: true, maxIterations: 100 },
        mockContext,
      )
      expect(report.dry_run).toBe(false)

      const after = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
      expect(after).not.toBe(before)
      expect(after).toMatch(/console\.error\('\[AnyaAudit\] Suppressed error/)
      expect(after).toMatch(/throw err/)

      expect(report.issues_fixed).toBeGreaterThan(0)
      const totalReported = report.modifications.reduce((acc, m) => acc + m.changes_count, 0)
      expect(report.issues_fixed).toBe(totalReported)
    } finally {
      delete process.env.ANYA_AUTONOMOUS_WRITE_CHANGES
    }
  })
})
