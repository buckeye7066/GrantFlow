/**
 * Tests for anyaHelpKnowledge.js — Anya app knowledge module.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HELP_REGISTRY,
  getHelpForRoute,
  getHelpForField,
  searchHelp,
  getAppOverview,
} from '../../backend/services/anyaHelpKnowledge.js'

// ── getHelpForRoute ────────────────────────────────────────────────────────

test('getHelpForRoute returns structured data for Dashboard', () => {
  const entry = getHelpForRoute('Dashboard')
  assert.ok(entry, 'should return an entry')
  assert.equal(entry.key, 'Dashboard')
  assert.equal(entry.navGroup, 'home')
  assert.ok(typeof entry.description === 'string' && entry.description.length > 0)
  assert.ok(typeof entry.purpose === 'string' && entry.purpose.length > 0)
  assert.ok(Array.isArray(entry.mainActions) && entry.mainActions.length > 0)
})

test('getHelpForRoute returns structured data for MyProfiles', () => {
  const entry = getHelpForRoute('MyProfiles')
  assert.ok(entry)
  assert.equal(entry.affectsMatching, true)
  assert.ok(Array.isArray(entry.fields) && entry.fields.length > 0)
})

test('getHelpForRoute returns undefined for unknown route', () => {
  assert.equal(getHelpForRoute('BogusPage'), undefined)
})

// ── getHelpForField ────────────────────────────────────────────────────────

test('getHelpForField returns structured data for zip', () => {
  const result = getHelpForField('zip')
  assert.ok(result, 'should return a result')
  assert.equal(result.field.key, 'zip')
  assert.ok(typeof result.field.explanation === 'string')
  assert.ok(typeof result.field.whyItMatters === 'string')
  assert.equal(result.field.required, true)
})

test('getHelpForField returns structured data for entity_type', () => {
  const result = getHelpForField('entity_type')
  assert.ok(result)
  assert.equal(result.field.affectsMatching, true)
  assert.equal(result.field.affectsCrawlers, true)
})

test('getHelpForField returns structured data for health_conditions', () => {
  const result = getHelpForField('health_conditions')
  assert.ok(result)
  assert.equal(result.field.affectsMatching, true)
})

test('getHelpForField returns undefined for unknown field', () => {
  assert.equal(getHelpForField('unknown_field_xyz'), undefined)
})

// ── searchHelp ────────────────────────────────────────────────────────────

test('searchHelp returns relevant results for "matching"', () => {
  const results = searchHelp('matching')
  assert.ok(results.length > 0)
  const keys = results.map((r) => r.key)
  assert.ok(keys.includes('SmartMatcher') || keys.includes('ProfileMatcher'))
})

test('searchHelp returns relevant results for "deadline"', () => {
  const results = searchHelp('deadline')
  assert.ok(results.length > 0)
  const keys = results.map((r) => r.key)
  assert.ok(keys.includes('GrantDeadline') || keys.includes('Calendar'))
})

test('searchHelp returns all entries when query is empty string', () => {
  assert.equal(searchHelp('').length, HELP_REGISTRY.length)
})

test('searchHelp is case-insensitive', () => {
  const lower = searchHelp('pipeline')
  const upper = searchHelp('PIPELINE')
  assert.deepEqual(
    lower.map((r) => r.key),
    upper.map((r) => r.key),
  )
})

// ── getAppOverview ────────────────────────────────────────────────────────

test('getAppOverview returns a valid JSON string', () => {
  const json = getAppOverview()
  assert.ok(typeof json === 'string', 'should return a string')
  assert.doesNotThrow(() => JSON.parse(json), 'should be valid JSON')
})

test('getAppOverview includes all pages', () => {
  const { pages } = JSON.parse(getAppOverview())
  assert.ok(Array.isArray(pages))
  assert.ok(pages.length >= 30, `Expected >= 30 pages, got ${pages.length}`)
})

test('getAppOverview includes matchingFields array with zip', () => {
  const { matchingFields } = JSON.parse(getAppOverview())
  assert.ok(Array.isArray(matchingFields))
  const zip = matchingFields.find((f) => f.key === 'zip')
  assert.ok(zip, 'zip field should be in matchingFields')
  assert.ok(zip.affectsCrawlers, 'zip should affect crawlers')
})
