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

// ── New funding-discovery knowledge (this-session features) ─────────────────

test('DiscoverGrants explains firing all relevant crawlers gated by profile type', () => {
  const entry = getHelpForRoute('DiscoverGrants')
  assert.ok(entry, 'DiscoverGrants entry should exist')
  const p = entry.purpose.toLowerCase()
  // Live federal connectors
  assert.ok(p.includes('grants.gov'), 'mentions Grants.gov')
  assert.ok(p.includes('nih'), 'mentions NIH')
  assert.ok(p.includes('usaspending'), 'mentions USASpending')
  assert.ok(p.includes('propublica'), 'mentions ProPublica foundations')
  assert.ok(/sam\.gov|cfda/.test(p), 'mentions SAM.gov / CFDA federal listings')
  assert.ok(/fema/.test(p) && /cdc/.test(p), 'mentions FEMA and CDC')
  // Curated catalog + background dispatch
  assert.ok(p.includes('curated'), 'mentions curated catalog')
  assert.ok(p.includes('background'), 'mentions background crawlers')
  // Profile-type gating examples
  assert.ok(p.includes('corporation') && p.includes('student'), 'mentions profile-type gating examples')
  // Results rules
  assert.ok(p.includes('hard floor'), 'explains slider hard floor')
  assert.ok(/saved or dismissed|pipeline/.test(p), 'explains pipeline exclusion')
  // No overpromising: it may say it "never guarantees", but must not promise guaranteed funding.
  assert.ok(!/\bguaranteed funding\b/.test(p), 'must not promise guaranteed funding')
  assert.ok(p.includes('never guarantees funding'), 'explicitly disclaims guaranteed funding')
})

test('FundingResults explains the slider hard floor, pipeline exclusion, and new categories', () => {
  const entry = getHelpForRoute('FundingResults')
  assert.ok(entry)
  const p = entry.purpose.toLowerCase()
  assert.ok(p.includes('hard floor'), 'explains slider hard floor')
  assert.ok(/saved or dismissed|never shown again/.test(p), 'explains pipeline exclusion')
  assert.ok(p.includes('corporate'), 'mentions corporate matching-gift / foundation grants')
  assert.ok(/re-entry|reentry|justice-involved/.test(p), 'mentions re-entry / justice-involved funding')
  assert.ok(/copay|assistance foundation/.test(p), 'mentions patient/disease-specific assistance')
  assert.ok(p.includes('endowment'), 'mentions school endowments')
})

test('MyProfiles has an accurate clinical_trials_opt_in field', () => {
  const result = getHelpForField('clinical_trials_opt_in')
  assert.ok(result, 'clinical_trials_opt_in field should exist')
  assert.equal(result.page.key, 'MyProfiles')
  const f = result.field
  assert.ok(typeof f.label === 'string' && f.label.length > 0)
  assert.ok(typeof f.explanation === 'string' && f.explanation.length > 0)
  assert.ok(typeof f.whyItMatters === 'string' && f.whyItMatters.length > 0)
  // It is opt-in / default OFF and is the user's choice
  const blob = `${f.explanation} ${f.whyItMatters}`.toLowerCase()
  assert.ok(blob.includes('off by default') || blob.includes('opt-in'), 'states opt-in / default OFF')
  assert.ok(blob.includes('clinicaltrials.gov'), 'references ClinicalTrials.gov')
  assert.ok(blob.includes('recruiting'), 'mentions recruiting studies')
  // Safety guarantees: never enroll / submit / share; a study is not funding
  assert.ok(blob.includes('never enroll'), 'states GrantFlow never enrolls')
  assert.ok(/never submit/.test(blob), 'states GrantFlow never submits')
  assert.ok(/never share|never shares/.test(blob), 'states GrantFlow never shares medical info')
  assert.ok(/not funding/.test(blob), 'clarifies a study is NOT funding')
  // Schema correctness for a field entry
  assert.equal(f.affectsMatching, false)
  assert.equal(f.affectsCrawlers, true)
  assert.equal(f.required, false)
})

test('Automation entry explains Robert background discovery and its limits', () => {
  const entry = getHelpForRoute('Automation')
  assert.ok(entry)
  const p = entry.purpose.toLowerCase()
  assert.ok(p.includes('robert'), 'mentions Robert')
  assert.ok(p.includes('catalog'), 'mentions mining the existing catalog')
  assert.ok(/email/.test(p), 'mentions reading emailed funding leads')
  assert.ok(/accept or reject|recommend/.test(p), 'mentions user accepts/rejects recommendations')
  assert.ok(/does not crawl the open web|not his job/.test(p), 'clarifies Robert does NOT do open-web lead discovery')
})

test('new discovery knowledge is reachable via searchHelp', () => {
  assert.ok(searchHelp('clinical trials').some((e) => e.key === 'MyProfiles'), 'clinical trials findable')
  assert.ok(searchHelp('Robert').some((e) => e.key === 'Automation'), 'Robert findable')
  assert.ok(searchHelp('hard floor').some((e) => e.key === 'DiscoverGrants' || e.key === 'FundingResults'), 'slider hard floor findable')
})
