import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Regression tests for the GET /api/admin/geo/zip-coverage endpoint logic.
 *
 * The endpoint reports nationwide ZIP coverage. The `zipcodes` npm dataset
 * the crawler uses includes ~2,500 non-state entries (Canadian provinces
 * like "ONTARIO" / "QUEBEC", military APO/FPO buckets AA/AE/AP, and US
 * territories PR/GU/VI/AS/MP/FM/MH/PW). The comprehensive crawler does
 * NOT walk these — its statesToRun list is exactly the 50 US states + DC.
 *
 * Before this fix, the "coverage_percent" field was computed against the
 * full dataset (44,175 entries), permanently capping reported coverage
 * at ~94% even when every reachable US ZIP was crawled. After this fix
 * the headline percentage is computed against the 50 states + DC universe
 * (41,689 ZIPs), so 100% reachable coverage reads as 100%.
 *
 * These tests cover the pure functions / data partitioning. They mirror
 * the exact set used in backend/routes/admin.js (CRAWLABLE_US_JURISDICTIONS).
 */

const CRAWLABLE_US_JURISDICTIONS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
])

function partitionDataset(zipObj) {
  const stateZipCounts = new Map()
  const crawlableZipSet = new Set()
  for (const zip of Object.keys(zipObj)) {
    const meta = zipObj[zip]
    const st = String(meta?.state || '').toUpperCase()
    if (!st) continue
    stateZipCounts.set(st, (stateZipCounts.get(st) || 0) + 1)
    if (CRAWLABLE_US_JURISDICTIONS.has(st)) {
      crawlableZipSet.add(String(zip).padStart(5, '0'))
    }
  }
  return { stateZipCounts, crawlableZipSet }
}

function computeHeadline(dataset, progressRows) {
  const { crawlableZipSet } = partitionDataset(dataset)
  let crawlableCompleted = 0
  for (const row of progressRows) {
    const zip = String(row.zip || '').padStart(5, '0')
    const meta = dataset[zip]
    const st = String(meta?.state || '').toUpperCase()
    if (
      String(row.status || '') === 'completed' &&
      CRAWLABLE_US_JURISDICTIONS.has(st) &&
      crawlableZipSet.has(zip)
    ) {
      crawlableCompleted += 1
    }
  }
  const crawlableUsZips = crawlableZipSet.size
  const coverage_percent =
    crawlableUsZips > 0 ? Math.round((crawlableCompleted / crawlableUsZips) * 1000) / 10 : 0
  const uncovered_zip_count = Math.max(0, crawlableUsZips - crawlableCompleted)
  return { crawlable_us_zips: crawlableUsZips, crawlable_completed: crawlableCompleted, coverage_percent, uncovered_zip_count }
}

test('crawlable set has exactly 50 US states + DC', () => {
  assert.equal(CRAWLABLE_US_JURISDICTIONS.size, 51)
  assert.ok(CRAWLABLE_US_JURISDICTIONS.has('DC'))
  assert.ok(CRAWLABLE_US_JURISDICTIONS.has('CA'))
  assert.ok(CRAWLABLE_US_JURISDICTIONS.has('TX'))
  // Non-crawlable: territories, military, foreign.
  assert.equal(CRAWLABLE_US_JURISDICTIONS.has('PR'), false)
  assert.equal(CRAWLABLE_US_JURISDICTIONS.has('AE'), false)
  assert.equal(CRAWLABLE_US_JURISDICTIONS.has('ONTARIO'), false)
  assert.equal(CRAWLABLE_US_JURISDICTIONS.has('QUEBEC'), false)
  assert.equal(CRAWLABLE_US_JURISDICTIONS.has('GU'), false)
})

test('100% real US coverage reads as 100% even when noisy territory entries are uncrawled', () => {
  const dataset = {
    '35004': { state: 'AL' },
    '99501': { state: 'AK' },
    '20500': { state: 'DC' },
    // Non-crawlable noise:
    '00601': { state: 'PR' },
    '96910': { state: 'GU' },
    '09001': { state: 'AE' },
    'A1A1A1': { state: 'ONTARIO' },
    'K1A0A6': { state: 'QUEBEC' },
  }
  const progress = [
    { zip: '35004', status: 'completed' },
    { zip: '99501', status: 'completed' },
    { zip: '20500', status: 'completed' },
    // Note: PR/GU/AE/Canadian are NOT completed. Headline should still be 100%.
  ]
  const headline = computeHeadline(dataset, progress)
  assert.equal(headline.crawlable_us_zips, 3, 'only 3 real US ZIPs in this fixture')
  assert.equal(headline.crawlable_completed, 3, 'all 3 are completed')
  assert.equal(headline.coverage_percent, 100, 'headline must show 100% nationwide')
  assert.equal(headline.uncovered_zip_count, 0)
})

test('partial real coverage reports honest percentage', () => {
  const dataset = {
    '35004': { state: 'AL' },
    '99501': { state: 'AK' },
    '85001': { state: 'AZ' },
    '90210': { state: 'CA' },
    '00601': { state: 'PR' },
  }
  const progress = [
    { zip: '35004', status: 'completed' },
    { zip: '99501', status: 'completed' },
    // AZ + CA not crawled; PR not crawled (and wouldn't count anyway).
  ]
  const headline = computeHeadline(dataset, progress)
  assert.equal(headline.crawlable_us_zips, 4)
  assert.equal(headline.crawlable_completed, 2)
  assert.equal(headline.coverage_percent, 50)
  assert.equal(headline.uncovered_zip_count, 2)
})

test('completed rows for non-crawlable jurisdictions do NOT inflate coverage', () => {
  const dataset = {
    '35004': { state: 'AL' },
    '00601': { state: 'PR' }, // territory
    'A1A1A1': { state: 'ONTARIO' }, // Canadian noise
  }
  const progress = [
    // Imagine a past one-off run that touched PR + ONTARIO somehow.
    { zip: '35004', status: 'completed' },
    { zip: '00601', status: 'completed' },
    { zip: 'A1A1A1', status: 'completed' },
  ]
  const headline = computeHeadline(dataset, progress)
  assert.equal(headline.crawlable_us_zips, 1, 'only AL is crawlable')
  assert.equal(headline.crawlable_completed, 1, 'only AL counts')
  assert.equal(headline.coverage_percent, 100)
  assert.equal(headline.uncovered_zip_count, 0)
})

test('failed / in_progress rows do not count toward coverage', () => {
  const dataset = {
    '35004': { state: 'AL' },
    '99501': { state: 'AK' },
  }
  const progress = [
    { zip: '35004', status: 'completed' },
    { zip: '99501', status: 'failed' },
  ]
  const headline = computeHeadline(dataset, progress)
  assert.equal(headline.crawlable_us_zips, 2)
  assert.equal(headline.crawlable_completed, 1)
  assert.equal(headline.coverage_percent, 50)
})
