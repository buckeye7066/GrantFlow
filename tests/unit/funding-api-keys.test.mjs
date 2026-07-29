import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getFundingApiKeyPresence,
  loadFundingApiKeys,
  validateFundingApiKeys,
} from '../../backend/src/config/apiKeys.js'

const SAM_KEY_NAMES = [
  'SAM_GOV_PUBLIC_API_KEY',
  'SAM_GOV_API_KEY',
  'SAM_GOV_KEY',
  'Sam_gov_key',
]

test('funding api keys presence never includes values', () => {
  const original = process.env.SIMPLER_GRANTS_API_KEY
  process.env.SIMPLER_GRANTS_API_KEY = 'secret-value-should-not-leak'
  try {
    const presence = getFundingApiKeyPresence()
    assert.equal(typeof presence.SIMPLER_GRANTS_API_KEY, 'boolean')

    // Sanity: ensure loadFundingApiKeys returns the value (internal),
    // but presence does not.
    const loaded = loadFundingApiKeys()
    assert.equal(loaded.SIMPLER_GRANTS_API_KEY, 'secret-value-should-not-leak')
    assert.equal(presence.SIMPLER_GRANTS_API_KEY, true)
  } finally {
    if (original == null) delete process.env.SIMPLER_GRANTS_API_KEY
    else process.env.SIMPLER_GRANTS_API_KEY = original
  }
})

test('validateFundingApiKeys finds missing required keys when enforced', () => {
  const keyNames = ['SIMPLER_GRANTS_API_KEY', ...SAM_KEY_NAMES]
  const originals = Object.fromEntries(keyNames.map((key) => [key, process.env[key]]))

  for (const key of keyNames) delete process.env[key]

  try {
    const res = validateFundingApiKeys({ enforce: true })
    assert.equal(res.enforced, true)
    assert.equal(res.ok, false)
    assert.deepEqual(
      new Set(res.missing),
      new Set(['SIMPLER_GRANTS_API_KEY', 'SAM_GOV_PUBLIC_API_KEY']),
    )
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
})
