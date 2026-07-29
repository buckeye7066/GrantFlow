import fs from 'node:fs'

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function write(file, text) {
  fs.writeFileSync(file, text)
}

function replaceOne(file, pattern, replacement, label) {
  const before = read(file)
  const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${label || file}: expected one match, found ${matches.length}`)
  }
  write(file, before.replace(pattern, replacement))
}

replaceOne(
  'tests/unit/healthz-schema-bootstrap.test.mjs',
  / \*   3\. Missing tables are surfaced in the body so operators know exactly\n \*      which invariants were violated\./,
  ` *   3. Public liveness reports an opaque missing-table count without exposing
 *      internal schema names or raw database errors.`,
  'healthz test documentation',
)

replaceOne(
  'tests/unit/healthz-schema-bootstrap.test.mjs',
  /    assert\.deepEqual\(body\.missing_tables, \['users'\]\)\n    assert\.match\(String\(body\.detail\), \/syntax error\/\)/,
  `    assert.equal(body.missing_table_count, 1)
    assert.equal(body.missing_tables, undefined)
    assert.equal(body.detail, undefined)
    assert.equal(body.details_redacted, true)`,
  'healthz single-table redaction assertions',
)

replaceOne(
  'tests/unit/healthz-schema-bootstrap.test.mjs',
  /    assert\.equal\(body\.reason, 'db_startup_error'\)\n    assert\.match\(String\(body\.detail\), \/connection refused\/\)/,
  `    assert.equal(body.reason, 'db_startup_error')
    assert.equal(body.detail, undefined)
    assert.equal(body.details_redacted, true)`,
  'healthz DB redaction assertions',
)

replaceOne(
  'tests/unit/healthz-schema-bootstrap.test.mjs',
  /    assert\.deepEqual\(body\.missing_tables, \['users', 'profiles', 'grants'\]\)/,
  `    assert.equal(body.missing_table_count, 3)
    assert.equal(body.missing_tables, undefined)
    assert.equal(body.details_redacted, true)`,
  'healthz multi-table redaction assertions',
)

replaceOne(
  'tests/unit/startup-smoke-mode.test.mjs',
  /test\('backend\/start\.js calls runMigrationsInBackground after boot', \(\) => \{[\s\S]*?\n\}\)/,
  `test('backend/start.js does not start a second migration runner', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/start.js'), 'utf8')
  assert.ok(
    !src.includes('runMigrationsInBackground()'),
    'server.js is the single migration owner; start.js must not launch a second runner',
  )
})`,
  'single migration owner assertion',
)

// Vitest workers can reuse a process across files. A neighboring suite that
// deliberately sets an agent/provider variable must never redefine another
// suite's documented default. Pin each default-contract test to a clean local
// environment as well as isolating the top-level test runner.
replaceOne(
  'backend/tests/amyAgent.test.js',
  /      delete process\.env\.AMY_RUN_ON_STARTUP\n      expect\(getAmyConfig\(\)\.enabled\)\.toBe\(true\)/,
  `      delete process.env.AMY_RUN_ON_STARTUP
      delete process.env.AMY_DAILY_PROFILE_TARGET
      expect(getAmyConfig().enabled).toBe(true)`,
  'Amy default target isolation',
)

replaceOne(
  'backend/tests/yanaScheduler.test.js',
  /beforeEach\(\(\) => \{\n  _resetYanaSchemaCache\(\)\n  __testing__\._resetLock\(\)\n\}\)/,
  `beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('YANA_')) delete process.env[key]
  }
  _resetYanaSchemaCache()
  __testing__._resetLock()
})`,
  'Yana scheduler environment isolation',
)

replaceOne(
  'backend/tests/hamiltonWeeklyDigest.test.js',
  /const ENV_KEYS = \['HAMILTON_WEEKLY_DIGEST_DELIVERY', 'HAMILTON_WEEKLY_DIGEST_ENABLED'\]/,
  `const ENV_KEYS = [
  'HAMILTON_WEEKLY_DIGEST_DELIVERY',
  'HAMILTON_WEEKLY_DIGEST_ENABLED',
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
]`,
  'Hamilton digest provider environment isolation',
)

console.log('[global-hardening] test contract updates applied')
