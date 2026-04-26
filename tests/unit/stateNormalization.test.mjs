import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const modulePath = path.resolve(__dirname, '..', '..', 'backend', 'utils', 'stateNormalization.js')
const moduleUrl = pathToFileURL(modulePath).href

const {
  normalizeOpportunityState,
  normalizeStateFromText,
} = await import(moduleUrl)

test('stateNormalization: extracts full state names from freeform profile location text', () => {
  assert.equal(normalizeStateFromText('Beaver County, Pennsylvania'), 'PA')
})

test('stateNormalization: opportunity state only allows USPS codes, nationwide, or null', () => {
  assert.equal(normalizeOpportunityState('Pennsylvania'), 'PA')
  assert.equal(normalizeOpportunityState('pa'), 'PA')
  assert.equal(normalizeOpportunityState('nationwide'), 'nationwide')
  assert.equal(normalizeOpportunityState('USA'), null)
  assert.equal(normalizeOpportunityState('United States'), null)
  assert.equal(normalizeOpportunityState('nation-wide'), null)
})
