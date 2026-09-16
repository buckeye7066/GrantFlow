import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const migration = fs.readFileSync('backend/db/postgres/migrations/0192_grant_zip_progress_audit.sql', 'utf8')

test('production auditor receives only ZIP progress read access', () => {
  assert.match(migration, /IF EXISTS[\s\S]*rolname = 'grantflow_auditor'/)
  assert.match(migration, /GRANT SELECT ON TABLE national_zip_progress TO grantflow_auditor/)
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE|ALL)/)
})
