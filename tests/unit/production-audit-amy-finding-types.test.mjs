import assert from 'node:assert/strict'
import test from 'node:test'

import { safeAmyFindingTypeCounts } from '../../scripts/production-audit/db-audit.mjs'

test('Amy audit logs only aggregate machine finding classes', () => {
  assert.deepEqual(safeAmyFindingTypeCounts({
    provider_unavailable: 3,
    zero_stored: 5,
    'profile name': 2,
    unsafe: 'profile-specific prose',
    negative: -1,
  }), {
    provider_unavailable: 3,
    zero_stored: 5,
  })
})
