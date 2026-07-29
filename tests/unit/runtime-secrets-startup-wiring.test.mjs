import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('server boot initializes and migrates the dedicated runtime-secret key before restore', () => {
  const source = fs.readFileSync('backend/server.js', 'utf8')
  const initializeAt = source.indexOf('ensureRuntimeSecretKeyMaterial(process.env)')
  const migrateAt = source.indexOf('migrateRuntimeSecretRows(db')
  const restoreAt = source.indexOf('async function restoreRuntimeSecretIfMissing')

  assert.ok(initializeAt >= 0, 'server must initialize dedicated key material')
  assert.ok(migrateAt > initializeAt, 'legacy rows must be migrated after key initialization')
  assert.ok(restoreAt > migrateAt, 'provider secrets must be restored only after migration')
  assert.match(source, /if \(isProdEnv\) process\.exit\(1\)/)
})

test('production readiness aggregates runtime-secret key security', () => {
  const source = fs.readFileSync('backend/services/productionReadinessChecks.js', 'utf8')
  assert.match(source, /export function checkRuntimeSecretKeySecurity/)
  assert.match(source, /checkRuntimeSecretKeySecurity\(\{ env \}\)/)
})
