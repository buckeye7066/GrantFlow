/**
 * Unit tests for samSafeFixes.js.
 *
 * Critical guarantees:
 *   - Sam refuses fix actions without admin authorisation.
 *   - Sam refuses unknown fix ids.
 *   - Sam refuses to write outside the allowlisted roots.
 *   - Sam refuses to modify forbidden paths (migrations, matchEngine, auth).
 *   - runWhitelistedCommand refuses unknown commands.
 *   - runWhitelistedCommand refuses commands containing shell metacharacters.
 *   - runWhitelistedCommand reports `skipped: script_not_found` for missing
 *     optional npm scripts (mission rule).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  applySafeFix,
  isPathSafeForFix,
  runWhitelistedCommand,
  __testing__ as safeFixInternals,
} from '../../backend/services/sam/samSafeFixes.js'
import { buildCommandWhitelist } from '../../backend/services/sam/samRegistry.js'

const REPO_ROOT = safeFixInternals.REPO_ROOT

// ---------------------------------------------------------------------------
// applySafeFix authorisation gate
// ---------------------------------------------------------------------------
test('applySafeFix refuses unknown fix id', async () => {
  const out = await applySafeFix({ fixId: 'nope', context: { authorisedByAdmin: true, mode: 'repair-safe' } })
  assert.equal(out.refused, true)
  assert.match(out.message, /unknown fix id/)
})

test('applySafeFix refuses without admin', async () => {
  const out = await applySafeFix({
    fixId: 'docs.regenerate-readiness-log',
    context: { authorisedByAdmin: false, mode: 'repair-safe' },
  })
  assert.equal(out.refused, true)
  assert.match(out.message, /not an authorised admin/)
})

test('applySafeFix refuses when mode is not repair-safe', async () => {
  const out = await applySafeFix({
    fixId: 'docs.regenerate-readiness-log',
    context: { authorisedByAdmin: true, mode: 'observe' },
  })
  assert.equal(out.refused, true)
  assert.match(out.message, /not repair-safe/)
})

test('applySafeFix accepts a docs log write under proper authorisation', async () => {
  const out = await applySafeFix({
    fixId: 'docs.regenerate-readiness-log',
    context: { authorisedByAdmin: true, mode: 'repair-safe' },
    params: { check_id: 'sam-self-test', content: 'all good' },
  })
  // We won't keep the file, but the write must succeed.
  assert.equal(out.applied, true)
  assert.match(out.evidence.file, /^docs\/_readiness_logs\/sam-sam-self-test/)
  // Clean up.
  const fs = await import('node:fs/promises')
  await fs.unlink(path.join(REPO_ROOT, out.evidence.file)).catch(() => {})
})

// ---------------------------------------------------------------------------
// isPathSafeForFix
// ---------------------------------------------------------------------------
test('isPathSafeForFix accepts files under allowed roots', () => {
  assert.equal(isPathSafeForFix('src/components/Foo.jsx'), true)
  assert.equal(isPathSafeForFix('docs/something.md'), true)
  assert.equal(isPathSafeForFix('backend/services/sam/samAgent.js'), true)
  assert.equal(isPathSafeForFix('backend/routes/sam.js'), true)
})

test('isPathSafeForFix rejects forbidden paths', () => {
  assert.equal(isPathSafeForFix('backend/db/migrations/079_x.sql'), false)
  assert.equal(isPathSafeForFix('backend/db/schema.sql'), false)
  assert.equal(isPathSafeForFix('backend/services/matchEngine.js'), false)
  assert.equal(isPathSafeForFix('backend/services/profileNormalizer.js'), false)
  assert.equal(isPathSafeForFix('backend/middleware/auth.js'), false)
  assert.equal(isPathSafeForFix('backend/routes/auth.js'), false)
  assert.equal(isPathSafeForFix('backend/routes/admin.js'), false)
  assert.equal(isPathSafeForFix('node_modules/foo/index.js'), false)
  assert.equal(isPathSafeForFix('.env.local'), false)
  assert.equal(isPathSafeForFix(''), false)
  assert.equal(isPathSafeForFix(null), false)
})

test('isPathSafeForFix rejects paths with disallowed extensions', () => {
  assert.equal(isPathSafeForFix('src/something.exe'), false)
  assert.equal(isPathSafeForFix('src/something.sh'), false)
})

// ---------------------------------------------------------------------------
// runWhitelistedCommand
// ---------------------------------------------------------------------------
test('runWhitelistedCommand refuses commands not in the whitelist', async () => {
  const out = await runWhitelistedCommand('rm -rf /')
  assert.equal(out.skipped, true)
  assert.match(out.stderr, /not in whitelist/)
})

test('runWhitelistedCommand refuses commands with shell metacharacters', async () => {
  const wl = new Set(['npm run -s lint:strict; ls'])
  const out = await runWhitelistedCommand('npm run -s lint:strict; ls', { whitelist: wl })
  assert.equal(out.skipped, true)
  assert.match(out.stderr, /shell metacharacters/)
})

test('runWhitelistedCommand returns skipped:script_not_found for missing npm scripts', async () => {
  // Force a fake whitelist that includes a deliberately missing script.
  const wl = new Set(['npm run -s sam:does-not-exist'])
  const out = await runWhitelistedCommand('npm run -s sam:does-not-exist', { whitelist: wl })
  assert.equal(out.skipped, true)
  assert.equal(out.skipped_reason, 'script_not_found')
  assert.equal(out.ok, true)
})

test('production-gate whitelist is the same Set returned by buildCommandWhitelist()', () => {
  const wl = buildCommandWhitelist()
  assert.ok(wl.size > 0)
  assert.ok(wl.has('npm run -s lint:strict'))
  assert.ok(wl.has('npm run -s typecheck'))
  assert.ok(wl.has('npm run -s build'))
})
