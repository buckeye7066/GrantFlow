import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scripts = Object.freeze({
  ownerAccess: new URL('../../scripts/verification/owner-profile-access.mjs', import.meta.url),
  comprehensive: new URL('../../scripts/comprehensive-app-test.mjs', import.meta.url),
  anyaStatus: new URL('../../scripts/check-anya-status.mjs', import.meta.url),
  anyaFix: new URL('../../scripts/trigger-anya-fix-tests.mjs', import.meta.url),
  geoCrawl: new URL('../../scripts/admin-geocrawl-until-complete.mjs', import.meta.url),
  reattach: new URL('../../scripts/reattach-users-simple.mjs', import.meta.url),
  verifyReattach: new URL('../../scripts/verify-reattach.mjs', import.meta.url),
  createFromDocs: new URL('../../backend/scripts/create-all-profiles-from-docs.mjs', import.meta.url),
})

const sources = Object.fromEntries(
  Object.entries(scripts).map(([name, url]) => [name, readFileSync(url, 'utf8')]),
)

const scopedEnvKeys = [
  'VERIFY_BACKEND_BASE_URL',
  'OWNER_EMAIL',
  'OWNER_ACCESS_TOKEN',
  'COMPREHENSIVE_TEST_API_BASE',
  'COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST',
  'COMPREHENSIVE_TEST_CONFIRM',
  'COMPREHENSIVE_TEST_ADMIN_TOKEN',
  'COMPREHENSIVE_TEST_ADMIN_EMAIL',
  'ANYA_CHECK_API_BASE',
  'ANYA_CHECK_ADMIN_TOKEN',
  'ANYA_FIX_API_BASE',
  'ANYA_FIX_CONFIRM_MUTATING_HOST',
  'ANYA_FIX_ADMIN_TOKEN',
  'ANYA_FIX_CONFIRM',
  'REATTACH_DB_PATH',
  'REATTACH_CONFIRM_DB_PATH',
  'REATTACH_ADMIN_USER_ID',
  'REATTACH_SUMMARY_PATH',
  'REATTACH_CONFIRM',
  'VERIFY_REATTACH_DB_PATH',
  'VERIFY_REATTACH_ADMIN_USER_ID',
  'VERIFY_REATTACH_OUTPUT_PATH',
  'PROFILE_DOCS_DB_PATH',
  'PROFILE_DOCS_CONFIRM_DB_PATH',
  'PROFILE_DOCS_SOURCE_DIR',
  'PROFILE_DOCS_UPLOADS_DIR',
  'PROFILE_DOCS_ADMIN_USER_ID',
  'PROFILE_DOCS_CONFIRM',
]

function runWithoutScopedEnv(url) {
  const env = { ...process.env }
  for (const key of scopedEnvKeys) delete env[key]
  return spawnSync(process.execPath, [fileURLToPath(url)], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('scoped operational scripts contain no retired owner mailbox authority', () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /buckeye7066|buckeye7066@gmail\.com/i, name)
    assert.doesNotMatch(source, /LIKE\s+['"]%buckeye7066%['"]/i, name)
  }
})

test('network scripts use explicit targets and credentials instead of preview-code auth', () => {
  assert.match(sources.ownerAccess, /requiredEnv\('VERIFY_BACKEND_BASE_URL'\)/)
  assert.match(sources.ownerAccess, /requiredEnv\('OWNER_EMAIL'\)/)
  assert.match(sources.ownerAccess, /requiredEnv\('OWNER_ACCESS_TOKEN'\)/)
  assert.doesNotMatch(sources.ownerAccess, /preview_token|password\/reset|setup\/complete/i)

  assert.match(sources.comprehensive, /requiredEnv\('COMPREHENSIVE_TEST_API_BASE'\)/)
  assert.match(sources.comprehensive, /requiredEnv\('COMPREHENSIVE_TEST_ADMIN_TOKEN'\)/)
  assert.match(sources.comprehensive, /requiredEnv\('COMPREHENSIVE_TEST_ADMIN_EMAIL'\)/)

  assert.match(sources.anyaStatus, /requiredEnv\('ANYA_CHECK_API_BASE'\)/)
  assert.match(sources.anyaStatus, /requiredEnv\('ANYA_CHECK_ADMIN_TOKEN'\)/)
  assert.match(sources.anyaFix, /requiredEnv\('ANYA_FIX_API_BASE'\)/)
  assert.match(sources.anyaFix, /requiredEnv\('ANYA_FIX_ADMIN_TOKEN'\)/)

  for (const source of [sources.comprehensive, sources.anyaStatus, sources.anyaFix]) {
    assert.doesNotMatch(source, /auth\/email\/(?:start|verify)|previewCode/i)
  }
})

test('mutating network and database scripts require explicit target confirmation', () => {
  assert.match(sources.comprehensive, /COMPREHENSIVE_TEST_CONFIRM_MUTATING_HOST/)
  assert.match(sources.comprehensive, /RUN_MUTATING_SUITE/)
  assert.match(sources.anyaFix, /ANYA_FIX_CONFIRM_MUTATING_HOST/)
  assert.match(sources.anyaFix, /APPLY_FIXES/)
  assert.match(sources.geoCrawl, /GF_CONFIRM_MUTATING_HOST/)
  assert.match(sources.reattach, /REATTACH_CONFIRM_DB_PATH/)
  assert.match(sources.reattach, /REATTACH_PROFILES/)
  assert.match(sources.createFromDocs, /PROFILE_DOCS_CONFIRM_DB_PATH/)
  assert.match(sources.createFromDocs, /CREATE_PROFILES/)
})

test('DB-local scripts resolve the explicit admin only through users.is_admin', () => {
  for (const name of ['reattach', 'verifyReattach', 'createFromDocs']) {
    assert.match(sources[name], /is_admin/)
    assert.match(sources[name], /ADMIN_USER_ID/)
    assert.doesNotMatch(sources[name], /primary_email\s+LIKE/i)
  }
  assert.match(sources.verifyReattach, /readonly:\s*true/)
})

test('every cleaned script refuses to run before network or DB access when config is absent', () => {
  const cases = [
    ['ownerAccess', 'VERIFY_BACKEND_BASE_URL'],
    ['comprehensive', 'COMPREHENSIVE_TEST_API_BASE'],
    ['anyaStatus', 'ANYA_CHECK_API_BASE'],
    ['anyaFix', 'ANYA_FIX_API_BASE'],
    ['reattach', 'REATTACH_DB_PATH'],
    ['verifyReattach', 'VERIFY_REATTACH_DB_PATH'],
    ['createFromDocs', 'PROFILE_DOCS_DB_PATH'],
  ]

  for (const [name, expected] of cases) {
    const result = runWithoutScopedEnv(scripts[name])
    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`)
    assert.match(result.stderr, new RegExp(`${expected} is required`), name)
  }
})

test('DB mutation confirmation is evaluated before opening the selected database', () => {
  const reattachConfirm = sources.reattach.indexOf("requiredEnv('REATTACH_CONFIRM')")
  const reattachOpen = sources.reattach.indexOf('new Database')
  assert.ok(reattachConfirm >= 0 && reattachConfirm < reattachOpen)

  const profileDocsConfirm = sources.createFromDocs.indexOf("requiredEnv('PROFILE_DOCS_CONFIRM')")
  const profileDocsOpen = sources.createFromDocs.indexOf('new Database')
  assert.ok(profileDocsConfirm >= 0 && profileDocsConfirm < profileDocsOpen)
})
