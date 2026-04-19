import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
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

describe('anyaAutonomousCrawler: honest-metrics contract', () => {
  let tmp2
  let cwd2

  // Re-seed every file before each test so tests that actually apply writes
  // don't leak state into subsequent tests.
  async function seedFixture() {
    await fs.rm(path.join(tmp2, 'src'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(tmp2, 'assets'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(tmp2, 'node_modules'), { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(tmp2, 'src'), { recursive: true })
    await fs.mkdir(path.join(tmp2, 'assets'), { recursive: true })
    await fs.mkdir(path.join(tmp2, 'node_modules', 'pkg'), { recursive: true })

    await fs.writeFile(path.join(tmp2, 'src/a.js'), 'export const a = 1\n', 'utf8')
    await fs.writeFile(
      path.join(tmp2, 'src/b.js'),
      [
        'function q() {',
        '  try { f() }',
        '  catch (err) {}',
        '}',
        '// TODO: drop this',
        "const mockData = [1]",
        "console.log('noise')",
        '',
      ].join('\n'),
      'utf8',
    )
    await fs.writeFile(path.join(tmp2, 'src/c.ts'), 'export const c = 2\n', 'utf8')
    // Non-text files discovered but must NOT contribute to files_scanned
    await fs.writeFile(path.join(tmp2, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await fs.writeFile(path.join(tmp2, 'assets/data.bin'), Buffer.from([0x00, 0x01, 0x02]))
    // Inside node_modules, must be skipped entirely
    await fs.writeFile(path.join(tmp2, 'node_modules/pkg/index.js'), 'module.exports = {}\n', 'utf8')
  }

  beforeAll(async () => {
    cwd2 = process.cwd()
    tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'anya-metrics-'))
    process.chdir(tmp2)
  })

  beforeEach(async () => {
    await seedFixture()
    delete process.env.ANYA_AUTONOMOUS_WRITE_CHANGES
  })

  afterAll(async () => {
    process.chdir(cwd2)
    await fs.rm(tmp2, { recursive: true, force: true }).catch(() => {})
  })

  it('files_scanned is NOT equal to findings_found (the old inflation bug)', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, maxIterations: 100 }, mockContext)
    // files_scanned counts real filesystem entries that were scanned
    // findings_found counts regex hits across those files
    // These must not be auto-equal.
    expect(r.files_scanned).toBeGreaterThan(0)
    expect(r.findings_found).toBeGreaterThan(0)

    // files_scanned = 3 text files (a.js + b.js + c.ts); ignored dirs + binary
    // assets excluded.
    expect(r.files_scanned).toBe(3)

    // findings_found must be computed from per-file issue sums, not from
    // file count. Prove it by summing and comparing.
    const summedFromFiles = r.issue_summary_by_file.reduce((acc, f) => acc + f.issueCount, 0)
    expect(r.findings_found).toBe(summedFromFiles)

    // And the numeric values must differ (the OLD bug assigned
    // files_scanned = findings_count, which this fixture proves is wrong).
    expect(r.files_scanned).not.toBe(r.findings_found)

    // files_discovered > files_scanned because 2 binary files were discovered
    // but filtered out.
    expect(r.files_discovered).toBeGreaterThan(r.files_scanned)
    expect(r.files_discovered).toBe(5) // 3 text + 2 binary at the leaf level

    // files_with_findings = files that produced >= 1 issue
    // (only b.js has issues in this fixture)
    expect(r.files_with_findings).toBe(1)

    // Legacy field matches canonical
    expect(r.issues_found).toBe(r.findings_found)
  })

  it('dry_run provenance: requested, effective, forced_by_env are distinguishable', async () => {
    // Case 1: caller requests dry run explicitly
    delete process.env.ANYA_AUTONOMOUS_WRITE_CHANGES
    const r1 = await runAutonomousCodeCrawl({ dryRun: true }, mockContext)
    expect(r1.dry_run_requested).toBe(true)
    expect(r1.dry_run_effective).toBe(true)
    expect(r1.dry_run_forced_by_env).toBe(false)
    expect(r1.writes_explicitly_enabled).toBe(false)
    expect(r1.dry_run).toBe(r1.dry_run_effective) // legacy alias

    // Case 2: caller requests writes but env gate vetoes
    delete process.env.ANYA_AUTONOMOUS_WRITE_CHANGES
    const r2 = await runAutonomousCodeCrawl({ dryRun: false }, mockContext)
    expect(r2.dry_run_requested).toBe(false)
    expect(r2.dry_run_effective).toBe(true)
    expect(r2.dry_run_forced_by_env).toBe(true)
    expect(r2.writes_explicitly_enabled).toBe(false)

    // Case 3: caller requests writes AND env gate opens
    process.env.ANYA_AUTONOMOUS_WRITE_CHANGES = 'true'
    try {
      const r3 = await runAutonomousCodeCrawl({ dryRun: false }, mockContext)
      expect(r3.dry_run_requested).toBe(false)
      expect(r3.dry_run_effective).toBe(false)
      expect(r3.dry_run_forced_by_env).toBe(false)
      expect(r3.writes_explicitly_enabled).toBe(true)
    } finally {
      delete process.env.ANYA_AUTONOMOUS_WRITE_CHANGES
    }
  })

  it('modifications include actionable details (diff, diff_preview, backup, dry_run flags)', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, fixEmptyCatch: true }, mockContext)
    expect(r.modifications.length).toBeGreaterThan(0)
    for (const m of r.modifications) {
      // Required actionable fields
      expect(typeof m.file).toBe('string')
      expect(m.changes_count).toBeGreaterThan(0)
      expect(Array.isArray(m.fixes_applied)).toBe(true)
      expect(m.fixes_applied.length).toBe(m.changes_count)
      for (const fx of m.fixes_applied) {
        expect(typeof fx.kind).toBe('string')
        expect(typeof fx.message).toBe('string')
      }
      expect(typeof m.diff).toBe('string')
      expect(m.diff.length).toBeGreaterThan(0)
      expect(typeof m.diff_preview).toBe('string')
      expect(m.diff_preview.length).toBeGreaterThan(0)
      // Preview is bounded
      expect(m.diff_preview.split('\n').length).toBeLessThanOrEqual(41)

      // dry-run provenance mirrored into each modification
      expect(typeof m.dry_run).toBe('boolean')
      expect(typeof m.dry_run_requested).toBe('boolean')
      expect(typeof m.dry_run_forced_by_env).toBe('boolean')

      // SHA1 integrity
      expect(m.before_sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(m.after_sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(m.before_sha1).not.toBe(m.after_sha1)

      // Backup is null in dry-run, path in apply mode
      if (m.dry_run) {
        expect(m.backup).toBeNull()
      } else {
        expect(typeof m.backup).toBe('string')
        expect(m.backup.length).toBeGreaterThan(0)
      }
    }
  })

  it('report surfaces _deprecated_fields marker so consumers can migrate', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true }, mockContext)
    expect(r._deprecated_fields).toBeTruthy()
    expect(typeof r._deprecated_fields.issues_found).toBe('string')
    expect(typeof r._deprecated_fields.dry_run).toBe('string')
  })

  it('ignored directories (node_modules) contribute NOTHING to any metric', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true }, mockContext)
    // node_modules/pkg/index.js must not appear anywhere
    const allPaths = [
      ...(r.issue_summary_by_file || []).map((f) => f.file),
      ...(r.modifications || []).map((m) => m.file),
    ]
    for (const p of allPaths) {
      expect(p).not.toMatch(/node_modules/)
    }
  })
})
