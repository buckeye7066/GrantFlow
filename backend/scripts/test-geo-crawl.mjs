import axios from 'axios'
import Database from 'better-sqlite3'

// Make this script deterministic: block outbound HTTP so we only test the
// ZIP→directory sources path (no reliance on external services).
axios.get = async () => {
  throw new Error('network disabled by test script')
}
axios.post = async () => {
  throw new Error('network disabled by test script')
}

const { runNationalZipCrawl } = await import('../services/crawlers/nationalZipCrawler.js')

const db = new Database(':memory:')

// Minimal schema required by nationalZipCrawler.saveOpportunity + progress tracking.
db.exec(`
  CREATE TABLE IF NOT EXISTS funding_opportunities (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    title TEXT NOT NULL,
    sponsor TEXT,
    description TEXT,
    source TEXT,
    source_id TEXT,
    source_url TEXT,
    application_url TEXT,
    evidence_url TEXT,
    is_national BOOLEAN DEFAULT FALSE,
    state TEXT,
    categories TEXT DEFAULT '[]',
    keywords TEXT DEFAULT '[]',
    opportunity_type TEXT,
    type TEXT DEFAULT 'OPPORTUNITY',
    requires_match BOOLEAN DEFAULT FALSE,
    match_percentage REAL,
    last_verified_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`)

const zip = process.argv[2] || '10001'

console.log(`Running geo crawl test for ZIP ${zip} (network disabled)...`)

const first = await runNationalZipCrawl(db, {
  zip_list: [zip],
  max_zips: 1,
  batch_size: 1,
  rate_limit_ms: 0,
  min_sources_per_zip: 3,
  discover_local_resources: true,
  overpass_radius_km: 5,
  overpass_max_results: 25,
  resume: false,
})

const rows1 = db.prepare('SELECT source, source_id, title, state, is_national FROM funding_opportunities ORDER BY source, source_id').all()
console.log('Result (first run):', first)
console.log(`DB rows after first run: ${rows1.length}`)
console.log(rows1.slice(0, 8))

const second = await runNationalZipCrawl(db, {
  zip_list: [zip],
  max_zips: 1,
  batch_size: 1,
  rate_limit_ms: 0,
  min_sources_per_zip: 3,
  discover_local_resources: true,
  overpass_radius_km: 5,
  overpass_max_results: 25,
  resume: false,
})

const rows2 = db.prepare('SELECT source, source_id, title, state, is_national FROM funding_opportunities ORDER BY source, source_id').all()
console.log('Result (second run):', second)
console.log(`DB rows after second run: ${rows2.length}`)
console.log(rows2.slice(0, 8))

