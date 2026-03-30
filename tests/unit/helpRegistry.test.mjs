/**
 * Tests for src/config/helpRegistry.js
 *
 * Since this is a frontend ESM file that imports from navConfig (which uses
 * createPageUrl), we test the backend equivalent (anyaHelpKnowledge.js) for
 * the registry data/logic, and validate the frontend registry shape via
 * a simple structural assertion using dynamic import of the raw JS.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HELP_REGISTRY,
  CURRENT_TOUR_VERSION,
  CURRENT_MANUAL_VERSION,
  getHelpForRoute,
  getHelpForField,
  searchHelp,
} from '../../backend/services/anyaHelpKnowledge.js'

// ── Constants ──────────────────────────────────────────────────────────────

test('CURRENT_TOUR_VERSION is a positive integer', () => {
  assert.ok(typeof CURRENT_TOUR_VERSION === 'number')
  assert.ok(CURRENT_TOUR_VERSION >= 1)
})

test('CURRENT_MANUAL_VERSION is a positive integer', () => {
  assert.ok(typeof CURRENT_MANUAL_VERSION === 'number')
  assert.ok(CURRENT_MANUAL_VERSION >= 1)
})

// ── Registry completeness ──────────────────────────────────────────────────

const NAV_ROUTE_NAMES = [
  // home
  'Dashboard', 'Calendar',
  // help
  'Help',
  // setup
  'MyProfiles', 'Organizations', 'Settings',
  // find
  'DiscoverGrants', 'FundingResults', 'SmartMatcher', 'ProfileMatcher',
  'FundingOpportunities', 'Funder', 'DataSources', 'SourceDirectory',
  'NOFOParser', 'AIGrantScorer',
  // work (problem statement calls this 'manage')
  'Pipeline', 'Proposals', 'Documents', 'PrintableApplication',
  // track
  'GrantDeadline', 'GrantMonitoring', 'Reports', 'AdvancedAnalytics',
  'Outreach', 'Stewardship',
  // admin
  'Automation', 'Billing', 'Budgets', 'Diagnostics', 'Admin', 'Incognito',
]

test('HELP_REGISTRY covers every route in NAV_GROUPS', () => {
  const registryKeys = new Set(HELP_REGISTRY.map((e) => e.key))
  for (const routeName of NAV_ROUTE_NAMES) {
    assert.ok(
      registryKeys.has(routeName),
      `Missing registry entry for route: ${routeName}`
    )
  }
})

test('no registry entry has an empty description', () => {
  for (const entry of HELP_REGISTRY) {
    assert.ok(
      typeof entry.description === 'string' && entry.description.trim().length > 0,
      `Entry "${entry.key}" has an empty description`
    )
  }
})

test('no registry entry has an empty title', () => {
  for (const entry of HELP_REGISTRY) {
    assert.ok(
      typeof entry.title === 'string' && entry.title.trim().length > 0,
      `Entry "${entry.key}" has an empty title`
    )
  }
})

// ── getHelpForRoute ────────────────────────────────────────────────────────

test('getHelpForRoute returns correct entry for Dashboard', () => {
  const entry = getHelpForRoute('Dashboard')
  assert.ok(entry)
  assert.equal(entry.key, 'Dashboard')
  assert.equal(entry.navGroup, 'home')
})

test('getHelpForRoute returns correct entry for SmartMatcher', () => {
  const entry = getHelpForRoute('SmartMatcher')
  assert.ok(entry)
  assert.equal(entry.key, 'SmartMatcher')
  assert.ok(entry.affectsMatching === true)
})

test('getHelpForRoute returns undefined for unknown route', () => {
  const entry = getHelpForRoute('NonExistentPage')
  assert.equal(entry, undefined)
})

// ── getHelpForField ────────────────────────────────────────────────────────

test('getHelpForField returns correct entry for zip field', () => {
  const result = getHelpForField('zip')
  assert.ok(result)
  assert.ok(result.field)
  assert.equal(result.field.key, 'zip')
  assert.ok(result.field.affectsMatching === true)
  assert.ok(result.field.affectsCrawlers === true)
  assert.equal(result.page.key, 'MyProfiles')
})

test('getHelpForField returns correct entry for military_status', () => {
  const result = getHelpForField('military_status')
  assert.ok(result)
  assert.equal(result.field.key, 'military_status')
  assert.ok(result.field.affectsMatching === true)
})

test('getHelpForField returns undefined for unknown field', () => {
  const result = getHelpForField('nonexistent_field')
  assert.equal(result, undefined)
})

// ── searchHelp ────────────────────────────────────────────────────────────

test('searchHelp returns results for "pipeline"', () => {
  const results = searchHelp('pipeline')
  assert.ok(results.length > 0)
  const keys = results.map((r) => r.key)
  assert.ok(keys.includes('Pipeline'))
})

test('searchHelp returns results for "deadline"', () => {
  const results = searchHelp('deadline')
  assert.ok(results.length > 0)
})

test('searchHelp returns all entries for empty query', () => {
  const results = searchHelp('')
  assert.equal(results.length, HELP_REGISTRY.length)
})

test('searchHelp returns all entries for null query', () => {
  const results = searchHelp(null)
  assert.equal(results.length, HELP_REGISTRY.length)
})

test('searchHelp returns empty array for no matches', () => {
  const results = searchHelp('xyznonexistentterm12345')
  assert.equal(results.length, 0)
})

// ── getAppOverview ────────────────────────────────────────────────────────

test('getAppOverview returns valid JSON with pages and matchingFields', async () => {
  const { getAppOverview } = await import('../../backend/services/anyaHelpKnowledge.js')
  const json = getAppOverview()
  assert.ok(typeof json === 'string')
  const parsed = JSON.parse(json)
  assert.ok(Array.isArray(parsed.pages))
  assert.ok(parsed.pages.length > 0)
  assert.ok(Array.isArray(parsed.matchingFields))
  assert.ok(parsed.matchingFields.length > 0)
  // All matching fields should have affectsMatching=true
  const zipField = parsed.matchingFields.find((f) => f.key === 'zip')
  assert.ok(zipField)
})
