import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/stripe-lifecycle-acceptance.yml', 'utf8')

test('isolated Stripe acceptance covers lifecycle, entitlement, checkout, and webhook boundaries', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /stripeSubscriptionSync\.test\.js/)
  assert.match(workflow, /entitlementService\.test\.js/)
  assert.match(workflow, /tierEnforcement\.test\.js/)
  assert.match(workflow, /services-catalog-and-stripe\.test\.mjs/)
  assert.match(workflow, /stripe-price-verifier\.test\.mjs/)
  assert.match(workflow, /grantflow-stripe-lifecycle-v1/)
  assert.match(workflow, /Upload acceptance receipt/)
})
