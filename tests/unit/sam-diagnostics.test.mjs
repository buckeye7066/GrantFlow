/**
 * Unit tests for samDiagnostics.js + samRegistry.js + samTypes.js.
 *
 * Covers:
 *   - default check list is non-empty and only references valid categories
 *   - unknown check ids produce a single info finding (never throw)
 *   - tool-style checks correctly mine findings from a tool's `issues[]`
 *   - failure of one check does not stop the rest
 *   - severity strings get normalised
 *   - secret masking redacts API keys + bearer tokens
 *   - status command whitelist refuses unknown commands
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHECK_KIND,
  DIAGNOSTIC_CHECKS,
  PRODUCTION_GATE_SCRIPTS,
  SAFE_FIX_REGISTRY,
  buildCommandWhitelist,
  defaultDiagnosticIds,
  getCheckById,
} from '../../backend/services/sam/samRegistry.js'
import {
  SAM_CATEGORY_LIST,
  SAM_MODE_LIST,
  SEVERITY,
  computeHealthScore,
  determineProductionReady,
  isValidMode,
  makeFinding,
  summariseFindings,
} from '../../backend/services/sam/samTypes.js'
import { runDiagnostics, __testing__ as diagInternals } from '../../backend/services/sam/samDiagnostics.js'
import { maskSecrets } from '../../backend/services/sam/samAuditStore.js'

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------
test('every diagnostic check has a valid category + kind', () => {
  assert.ok(DIAGNOSTIC_CHECKS.length > 0)
  for (const check of DIAGNOSTIC_CHECKS) {
    assert.ok(check.id, `check missing id`)
    assert.ok(SAM_CATEGORY_LIST.includes(check.category), `bad category for ${check.id}`)
    assert.ok(Object.values(CHECK_KIND).includes(check.kind), `bad kind for ${check.id}`)
  }
  // The operational default (observe/advise + agent-control cycle) EXCLUDES the
  // heavy code-quality checks (source-tree walks / ESLint / route fan-outs) so
  // Sam's preflight can never stall the agent cycle; includeHeavy=true
  // (gatekeeper/CI) runs the full set.
  const heavy = DIAGNOSTIC_CHECKS.filter((c) => c.heavy).map((c) => c.id)
  const nonHeavy = DIAGNOSTIC_CHECKS.filter((c) => !c.heavy).map((c) => c.id)
  assert.ok(heavy.length > 0, 'expected at least one heavy (gatekeeper-only) check')
  assert.deepEqual(defaultDiagnosticIds(), nonHeavy)
  assert.deepEqual(defaultDiagnosticIds({ includeHeavy: true }), DIAGNOSTIC_CHECKS.map((c) => c.id))
})

test('production-gate scripts are unique and reference valid categories', () => {
  const scripts = PRODUCTION_GATE_SCRIPTS.map((g) => g.script)
  assert.equal(new Set(scripts).size, scripts.length, 'duplicate gate script')
  for (const gate of PRODUCTION_GATE_SCRIPTS) {
    assert.ok(SAM_CATEGORY_LIST.includes(gate.category))
  }
})

test('safe-fix registry is small + every entry has an id', () => {
  assert.ok(SAFE_FIX_REGISTRY.length > 0)
  assert.ok(SAFE_FIX_REGISTRY.length <= 5, 'safe-fix registry should stay small')
  for (const fix of SAFE_FIX_REGISTRY) {
    assert.ok(fix.id)
    assert.ok(fix.label)
    assert.equal(fix.risk_level, 'safe')
  }
})

test('command whitelist only contains npm and node commands', () => {
  const wl = buildCommandWhitelist()
  for (const cmd of wl) {
    assert.ok(cmd.startsWith('npm run -s ') || cmd.startsWith('node '), `unexpected: ${cmd}`)
  }
})

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------
test('mode list contains exactly the four documented modes', () => {
  assert.deepEqual([...SAM_MODE_LIST].sort(), ['advise', 'gatekeeper', 'observe', 'repair-safe'])
  assert.equal(isValidMode('observe'), true)
  assert.equal(isValidMode('totally-fake'), false)
})

test('computeHealthScore + summariseFindings + determineProductionReady', () => {
  assert.equal(computeHealthScore([]), 100)
  const findings = [
    makeFinding({ severity: SEVERITY.CRITICAL, title: 'crit' }),
    makeFinding({ severity: SEVERITY.HIGH, title: 'high' }),
    makeFinding({ severity: SEVERITY.MEDIUM, title: 'med' }),
  ]
  const summary = summariseFindings(findings)
  assert.equal(summary.total, 3)
  assert.equal(summary.critical, 1)
  assert.equal(summary.high, 1)
  assert.equal(summary.medium, 1)
  assert.ok(computeHealthScore(findings) <= 100 - 25 - 10 - 4)
  assert.equal(determineProductionReady(findings), false)
  assert.equal(determineProductionReady([]), true)
})

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
test('runDiagnostics returns an info finding for unknown check ids', async () => {
  const { findings } = await runDiagnostics({
    db: null,
    ctx: null,
    checkIds: ['this.check.does.not.exist'],
    invokeTool: async () => ({ success: true }),
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].severity, 'info')
  assert.match(findings[0].title, /Unknown Sam check id/)
})

test('runDiagnostics surfaces issues from a tool result without crashing the whole run', async () => {
  const fakeTool = async (_db, _ctx, name) => {
    if (name === 'admin.code.scan') {
      return { success: true, issues: [{ severity: 'high', title: 'TODO leftover', file: 'src/app.js' }] }
    }
    if (name === 'admin.code.crawl') throw new Error('boom')
    return { success: true }
  }
  const { findings } = await runDiagnostics({
    db: null,
    ctx: null,
    checkIds: ['code.scan', 'code.crawl'],
    invokeTool: fakeTool,
  })
  // 1 high from code.scan + 1 medium for the throwing crawl
  assert.ok(findings.some((f) => f.title.includes('TODO leftover')))
  assert.ok(findings.some((f) => f.title.startsWith('Tool invocation failed')))
})

test('coerceToFinding maps non-canonical severities', () => {
  const f = diagInternals.coerceToFinding({ severity: 'fatal', title: 'x' }, getCheckById('code.scan'))
  assert.equal(f.severity, SEVERITY.CRITICAL)
})

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------
test('maskSecrets redacts API keys and bearer tokens', () => {
  const masked = maskSecrets('Authorization: Bearer abcdefghijklmnop1234567890\nANTHROPIC_API_KEY=sk-ant-very-secret-value-12345')
  assert.match(masked, /Authorization: Bearer \*\*\*REDACTED\*\*\*/)
  assert.match(masked, /\*\*\*REDACTED\*\*\*/)
  assert.ok(!masked.includes('sk-ant-very-secret-value-12345'))
  assert.ok(!masked.includes('abcdefghijklmnop1234567890'))
})

test('maskSecrets caps very long strings', () => {
  const huge = 'a'.repeat(200_000)
  const masked = maskSecrets(huge)
  assert.ok(masked.length <= 100_500)
})

test('maskSecrets walks objects', () => {
  const masked = maskSecrets({ env: 'API_KEY=secret-value-9999999999999' })
  assert.equal(typeof masked, 'object')
  assert.ok(!String(masked.env || '').includes('secret-value-9999999999999'))
})
