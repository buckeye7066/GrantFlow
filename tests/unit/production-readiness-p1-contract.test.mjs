import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { FINDINGS } from '../../scripts/production-audit/db-audit.mjs'

const finding = (id) => FINDINGS.find((entry) => entry.id === id)

test('nationwide ZIP evidence counts distinct fresh verified catalog sources, not progress counters', () => {
  const audit = finding('nationwide_zip_coverage')
  assert.ok(audit, 'protected production audit must measure nationwide ZIP coverage')
  assert.equal(audit.unscoped, true)
  assert.equal(audit.logRows, true, 'non-sensitive ZIP buckets must remain visible in workflow logs')
  assert.match(audit.sql, /count\(DISTINCT fo\.id\)/)
  assert.match(audit.sql, /fo\.is_active IS TRUE/)
  assert.match(audit.sql, /fo\.last_verified_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'/)
  assert.match(audit.sql, /application_url/)
  assert.match(audit.sql, /source_url/)
  assert.match(audit.sql, /evidence_url/)
  assert.match(audit.sql, /WHEN v\.verified_sources = 2 THEN '2'/)
})

test('production audit measures actual cited page-fact population', () => {
  const audit = finding('page_fact_provenance')
  assert.ok(audit, 'protected production audit must measure live provenance population')
  assert.equal(audit.unscoped, true)
  assert.match(audit.sql, /page_fact_schema_version/)
  assert.match(audit.sql, /field_provenance/)
  assert.match(audit.sql, /evidence_snippet/)
  assert.match(audit.sql, /e\.value ->> 'source'/)
  assert.match(audit.sql, /record_origin IN \('live_crawl', 'geo_crawl', 'discovered', 'scholarship_crawler'\)/)
})

test('canonical rules no longer claim the page-fact extractor is unbuilt', () => {
  const rules = fs.readFileSync('docs/canonical_rules.md', 'utf8')
  assert.doesNotMatch(rules, /extractor not yet built/i)
  assert.doesNotMatch(rules, /Nothing populates\s+them yet/i)
  assert.match(rules, /blindPageFactExtractor/)
  assert.match(rules, /nationwide_zip_coverage/)
  assert.match(rules, /runScheduledAutoDiscovery/)
})
