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
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
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
    const before = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
    expect(before).toMatch(/catch \(err\) \{\}/)

    const report = await runAutonomousCodeCrawl(
      { dryRun: false, writeFlag: true, fixEmptyCatch: true, maxIterations: 100 },
      mockContext,
    )
    expect(report.dry_run).toBe(false)
    expect(report.permission_required).toBe(false)
    expect(report.audit_required).toBe(true)
    expect(report.env_write_gate_required).toBe(false)

    const after = await fs.readFile(path.join(tmpDir, 'src/silent.js'), 'utf8')
    expect(after).not.toBe(before)
    expect(after).toMatch(/console\.error\('\[AnyaAudit\] Suppressed error/)
    expect(after).toMatch(/throw err/)

    expect(report.issues_fixed).toBeGreaterThan(0)
    const totalReported = report.modifications.reduce((acc, m) => acc + m.changes_count, 0)
    expect(report.issues_fixed).toBe(totalReported)
  })
})

describe('anyaAutonomousCrawler: honest-metrics contract', () => {
  let tmp2
  let cwd2

  // Re-seed every file before each test so tests that actually apply writes
  // don't leak state into subsequent tests.
  async function seedFixture() {
    await fs.rm(path.join(tmp2, 'src'), { recursive: true, force: true }).catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
    await fs.rm(path.join(tmp2, 'assets'), { recursive: true, force: true }).catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
    await fs.rm(path.join(tmp2, 'node_modules'), { recursive: true, force: true }).catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
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
  })

  afterAll(async () => {
    process.chdir(cwd2)
    await fs.rm(tmp2, { recursive: true, force: true }).catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
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

  it('dry_run provenance: requested, effective, and policy fields are distinguishable', async () => {
    // Case 1: caller requests dry run explicitly
    const r1 = await runAutonomousCodeCrawl({ dryRun: true }, mockContext)
    expect(r1.dry_run_requested).toBe(true)
    expect(r1.dry_run_effective).toBe(true)
    expect(r1.dry_run_forced_by_env).toBe(false)
    expect(r1.writes_explicitly_enabled).toBe(false)
    expect(r1.dry_run).toBe(r1.dry_run_effective) // legacy alias

    // Case 2: caller requests writes; no environment gate vetoes Anya repair.
    const r2 = await runAutonomousCodeCrawl({ dryRun: false, maxFileChanges: 0 }, mockContext)
    expect(r2.dry_run_requested).toBe(false)
    expect(r2.dry_run_effective).toBe(false)
    expect(r2.dry_run_forced_by_env).toBe(false)
    expect(r2.writes_explicitly_enabled).toBe(true)
    expect(r2.env_write_gate_required).toBe(false)
    expect(r2.permission_required).toBe(false)
    expect(r2.audit_required).toBe(true)
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

// ---------------------------------------------------------------------------
// Extended contract: new counters, pagination, separated analyzers, AST,
// domain audits, surfaced read/dir errors.
// ---------------------------------------------------------------------------
describe('anyaAutonomousCrawler: extended honest-metrics contract', () => {
  let tmp3
  let originalCwd3

  async function seedExtendedFixture() {
    // Full reset: remove ONLY the seeded child directories, never tmp3 itself.
    // On Linux, rm'ing the current working directory leaves process.cwd()
    // pointing at a dead inode -> ENOENT on any subsequent process.cwd()
    // call (as runAutonomousCodeCrawl does). Preserving tmp3 as the cwd
    // avoids that entirely while still giving each test a clean slate.
    for (const child of ['src', 'assets', 'node_modules', 'backend']) {
      await fs
        .rm(path.join(tmp3, child), { recursive: true, force: true })
        .catch(() => { /* intentionally ignored: test tmpdir cleanup is best-effort */ })
    }

    await fs.mkdir(path.join(tmp3, 'src'), { recursive: true })
    await fs.mkdir(path.join(tmp3, 'assets'), { recursive: true })
    await fs.mkdir(path.join(tmp3, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(tmp3, 'backend', 'services'), { recursive: true })
    await fs.mkdir(path.join(tmp3, 'backend', 'routes'), { recursive: true })

    await fs.writeFile(path.join(tmp3, 'src/a.js'), 'export const a = 1\n', 'utf8')
    // b.js: mix of literal / regex / heuristic / AST-precise findings
    await fs.writeFile(
      path.join(tmp3, 'src/b.js'),
      [
        'function q() {',
        '  try { f() }',
        '  catch (err) {}',            // heuristic + AST
        '}',
        '// TODO: drop this',          // literal
        '// FIXME: and this',          // literal
        'const mockData = [1]',        // regex
        'const sampleData = [2]',      // regex
        "console.log('noise')",        // AST (precise) + regex (fragile)
        '',
      ].join('\n'),
      'utf8',
    )
    // c.js: regex fires a false positive inside a string; AST MUST NOT
    await fs.writeFile(
      path.join(tmp3, 'src/c.js'),
      'const x = "console.log(this is a string, not a call)"\n',
      'utf8',
    )
    // Binary file: counted as skipped, not scanned
    await fs.writeFile(path.join(tmp3, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    // Ignored directory
    await fs.writeFile(path.join(tmp3, 'node_modules/pkg/index.js'), 'module.exports = {}\n', 'utf8')
    // Minimal matching sources so domain audits have something to inspect
    await fs.writeFile(
      path.join(tmp3, 'backend/services/matchEngine.js'),
      'export function match(profile) { return profile.state && profile.industry }\n',
      'utf8',
    )
    await fs.writeFile(
      path.join(tmp3, 'backend/services/matching.js'),
      'export async function runMatching() { /* total_found > 0 relaxation fallback */ }\n',
      'utf8',
    )
    // Good route: total_found + matches => no UI consistency finding
    await fs.writeFile(
      path.join(tmp3, 'backend/routes/grants.js'),
      'export default function() { const total_found = 5; return { total_found, matches: [] } }\n',
      'utf8',
    )
    // Bad route: total_found, no results array => UI consistency finding
    await fs.writeFile(
      path.join(tmp3, 'backend/routes/bad.js'),
      'export default function() { return { total_found: 5, nothing: true } }\n',
      'utf8',
    )
  }

  beforeAll(async () => {
    originalCwd3 = process.cwd()
    tmp3 = await fs.mkdtemp(path.join(os.tmpdir(), 'anya-extended-'))
    process.chdir(tmp3)
  })

  beforeEach(async () => {
    await seedExtendedFixture()
  })

  afterAll(async () => {
    process.chdir(originalCwd3)
    try { await fs.rm(tmp3, { recursive: true, force: true }) } catch { /* cleanup best-effort */ }
  })

  it('honest counters include files_skipped and scan_errors', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    expect(typeof r.files_discovered).toBe('number')
    expect(typeof r.files_scanned).toBe('number')
    expect(typeof r.files_with_findings).toBe('number')
    expect(typeof r.findings_found).toBe('number')
    expect(typeof r.files_skipped).toBe('number')
    expect(typeof r.scan_errors).toBe('number')
    expect(Array.isArray(r.scan_errors_detail)).toBe(true)
    // Binary asset (logo.png) was discovered but NOT scanned => counted as skipped
    expect(r.files_skipped).toBeGreaterThanOrEqual(1)
    expect(r.files_discovered).toBeGreaterThan(r.files_scanned)
  })

  it('findings include a search_kind and a breakdown is reported', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    expect(typeof r.search_kind_breakdown).toBe('object')
    // Each technique produced at least one finding in the fixture
    expect(r.search_kind_breakdown.literal).toBeGreaterThanOrEqual(2) // TODO + FIXME
    expect(r.search_kind_breakdown.regex).toBeGreaterThanOrEqual(1) // mockData
    expect(r.search_kind_breakdown.heuristic + r.search_kind_breakdown.ast).toBeGreaterThanOrEqual(1) // silent catch
    // Every returned finding has a search_kind label
    for (const f of r.findings) {
      expect(['literal', 'regex', 'heuristic', 'ast', 'domain_audit']).toContain(f.search_kind)
    }
  })

  it('literal analyzer is token-based (no regex) and tags each finding with the token', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    const literals = r.findings.filter((f) => f.search_kind === 'literal')
    expect(literals.length).toBeGreaterThanOrEqual(2)
    for (const l of literals) {
      expect(typeof l.token).toBe('string')
      expect(['TODO', 'FIXME', 'HACK', 'XXX']).toContain(l.token)
      expect(l.excerpt).toContain(l.token)
    }
  })

  it('AST analysis is available and more precise than regex for string-literal false positives', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    expect(r.ast_available).toBe(true)
    expect(r.ast_files_attempted).toBeGreaterThanOrEqual(3) // a.js, b.js, c.js
    expect(r.ast_files_failed).toBe(0)
    // AST ignores console.log inside a string literal in c.js
    const astInC = r.findings.filter((f) => f.search_kind === 'ast' && f.file === 'src/c.js')
    expect(astInC.length).toBe(0)
    // But regex fires on c.js (proving AST's value)
    const regexInC = r.findings.filter((f) => f.search_kind === 'regex' && f.file === 'src/c.js')
    expect(regexInC.length).toBeGreaterThan(0)
    // AST correctly flags the empty catch in b.js
    const astInBCatch = r.findings.filter(
      (f) => f.search_kind === 'ast' && f.file === 'src/b.js' && (f.type === 'silent_catch' || f.type === 'empty_catch'),
    )
    expect(astInBCatch.length).toBe(1)
  })

  it('skipAst option disables AST but other analyzers still run', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false, skipAst: true }, mockContext)
    expect(r.ast_files_attempted).toBe(0)
    expect(r.search_kind_breakdown.ast).toBe(0)
    expect(r.search_kind_breakdown.literal + r.search_kind_breakdown.regex).toBeGreaterThan(0)
  })

  it('returns ALL findings by default (nothing is silently truncated)', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    expect(r.findings_total).toBeGreaterThan(0)
    expect(r.findings.length).toBe(r.findings_total)
    expect(r.findings_truncated).toBe(false)
    expect(r.findings_offset).toBe(0)
    expect(r.findings_limit).toBe(r.findings_total)
    // issue_summary_by_file is also NOT silently capped
    expect(typeof r.issue_summary_by_file_count).toBe('number')
    expect(r.issue_summary_by_file.length).toBe(r.issue_summary_by_file_count)
  })

  it('supports explicit pagination via findingsLimit/findingsOffset', async () => {
    const full = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    const total = full.findings_total
    expect(total).toBeGreaterThanOrEqual(3)

    const page1 = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false, findingsLimit: 2 }, mockContext)
    expect(page1.findings.length).toBe(2)
    expect(page1.findings_total).toBe(total)
    expect(page1.findings_truncated).toBe(true)

    const page2 = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false, findingsLimit: 2, findingsOffset: 2 }, mockContext)
    expect(page2.findings.length).toBe(2)
    expect(page2.findings_offset).toBe(2)
    expect(page2.findings[0]).not.toEqual(page1.findings[0])
  })

  it('surfaces readdir errors (e.g. missing directory) instead of swallowing them', async () => {
    const r = await runAutonomousCodeCrawl(
      { directory: path.join(tmp3, '__nope__'), dryRun: true, includeDomainAudits: false },
      mockContext,
    )
    expect(r.scan_errors).toBeGreaterThanOrEqual(1)
    expect(r.scan_errors_detail.some((e) => e.stage === 'readdir')).toBe(true)
    // Errors must also appear in the unified errors array
    expect(r.errors.some((e) => e.stage === 'readdir')).toBe(true)
  })

  it('runs GrantFlow domain audits and returns a summary + individual findings', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: true }, mockContext)
    expect(r.domain_audit_summary).toBeTruthy()
    expect(r.domain_audit_summary.audits_run).toEqual(
      expect.arrayContaining([
        'opportunity_url_validity',
        'matching_coverage',
        'fallback_logic',
        'ui_backend_consistency',
        'anya_grounding',
      ]),
    )
    // matching_coverage should emit a finding since our fixture only touches 2 profile fields
    const matchingFinding = r.findings.find((f) => f.audit === 'matching_coverage')
    expect(matchingFinding).toBeTruthy()
    expect(Array.isArray(matchingFinding.evidence.missing_fields)).toBe(true)
    expect(matchingFinding.evidence.missing_fields.length).toBeGreaterThan(0)

    // ui_backend_consistency flags routes/bad.js but NOT routes/grants.js
    const uiFindings = r.findings.filter((f) => f.audit === 'ui_backend_consistency')
    expect(uiFindings.some((f) => String(f.file || '').includes('bad.js'))).toBe(true)
    expect(uiFindings.some((f) => String(f.file || '').includes('grants.js'))).toBe(false)

    // db-dependent audits surface a db_unavailable error, not a silent skip
    expect(r.errors.some((e) => /domain_audit:opportunity_url_validity/.test(e.stage || ''))).toBe(true)
    expect(r.errors.some((e) => /domain_audit:anya_grounding/.test(e.stage || ''))).toBe(true)
  })

  it('includeDomainAudits: false disables domain audits entirely', async () => {
    const r = await runAutonomousCodeCrawl({ dryRun: true, includeDomainAudits: false }, mockContext)
    expect(r.domain_audit_summary).toBeNull()
    expect(r.findings.some((f) => f.search_kind === 'domain_audit')).toBe(false)
  })
})
