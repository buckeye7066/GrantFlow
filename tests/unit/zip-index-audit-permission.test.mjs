import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const sql = fs.readFileSync('backend/db/postgres/migrations/0193_grant_zip_index_audit.sql', 'utf8')
test('production auditor receives read-only ZIP index access', () => {
  assert.match(sql, /GRANT SELECT ON TABLE funding_opportunity_geo_index TO grantflow_auditor/)
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)/)
})
