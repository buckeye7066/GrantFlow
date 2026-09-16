import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const policy = JSON.parse(fs.readFileSync('config/web-parity-acceptance-policy.json', 'utf8'))

test('production exact-50 policy encodes the owner-ratified meet-or-beat bar', () => {
  assert.equal(policy.owner_approved, true)
  assert.equal(policy.approved_by, 'Dr. John White / Axiom BioLabs')
  assert.equal(policy.metric, 'fleet_parity')
  assert.equal(policy.operator, 'gte')
  // fleet_parity is stored as a percentage, so ratio 1.0 == 100 percent.
  assert.equal(policy.threshold, 100)
  assert.equal(policy.cohort_size, 50)
})
