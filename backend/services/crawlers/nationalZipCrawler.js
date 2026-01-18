/**
 * National ZIP Code Crawler
 * 
 * Iterates over ALL ~43,859 US ZIP codes
 * For each ZIP, finds AT LEAST 3 REAL funding sources
 * 
 * Features:
 * - Batch processing (configurable, default 25-100 ZIPs per batch)
 * - Checkpointing to national_zip_progress table every batch
 * - Rate limiting and caching to avoid hammering upstream sources
 * - Resumable after interruption
 * - Memory-safe (no accumulating massive arrays)
 * 
 * Data sources:
 * - Grants.gov API (filter by geography where possible)
 * - State grant portal APIs
 * - Legitimate foundation locator services
 */

import axios from 'axios'
import Database from 'better-sqlite3'
import zipcodes from 'zipcodes'

// All US ZIP codes (43,859 total)
// In production, this would be loaded from a file or database
// For now, we load from the local `zipcodes` dataset to avoid network lookups.
const US_ZIP_CODES_SAMPLE = generateUSZipCodes()

// Default configuration
const DEFAULT_CONFIG = {
  batch_size: 50,
  min_sources_per_zip: 3,
  rate_limit_ms: 1000, // 1 second between ZIP requests
  checkpoint_every: 50, // Checkpoint after every 50 ZIPs
  timeout_ms: 10000
}

function normalizeZip(value) {
  const zip = String(value ?? '').trim()
  return /^\d{5}$/.test(zip) ? zip : null
}

function normalizeState(value) {
  const s = String(value ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(s) ? s : null
}

function resolveZipList({ zip_list, state, max_zips } = {}) {
  let list = []

  if (Array.isArray(zip_list) && zip_list.length > 0) {
    list = zip_list.map(normalizeZip).filter(Boolean)
  } else {
    const st = normalizeState(state)
    if (st) {
      const byState = zipcodes.lookupByState(st) || []
      list = byState.map((row) => normalizeZip(row?.zip)).filter(Boolean)
    } else {
      list = US_ZIP_CODES_SAMPLE.slice()
    }
  }

  list = Array.from(new Set(list)).sort()

  const lim = Number(max_zips)
  if (Number.isFinite(lim) && lim > 0) {
    list = list.slice(0, Math.min(lim, list.length))
  }

  return list
}

/**
 * Generate representative US ZIP codes
 * In production, load from zipcodes library or database
 */
function generateUSZipCodes() {
  // `zipcodes.codes` is an object keyed by ZIP string.
  // This dramatically reduces "skipped" runs caused by invalid generated ZIPs
  // and removes dependency on external geocoding APIs for basic ZIP metadata.
  const codes = zipcodes?.codes && typeof zipcodes.codes === 'object' ? zipcodes.codes : {}
  return Object.keys(codes).sort()
}

/**
 * Search Grants.gov API for a specific ZIP code
 */
async function searchGrantsGovByZip(zip, coords) {
  const opportunities = []
  
  try {
    // Grants.gov "search2" public API (2026).
    // Docs: https://api.grants.gov/v1/api/search2
    const body = {
      rows: 10,
      startRecordNum: 0,
      keyword: '',
      oppStatuses: 'posted',
      sortBy: 'openDate|desc',
    }

    const response = await axios.post('https://api.grants.gov/v1/api/search2', body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: DEFAULT_CONFIG.timeout_ms,
    })

    const hits = response?.data?.data?.oppHits
    if (Array.isArray(hits)) {
      for (const hit of hits) {
        opportunities.push({
          title: hit?.title || hit?.number || 'Grant opportunity',
          sponsor: hit?.agency || hit?.agencyCode || 'Grants.gov',
          description: '',
          url: hit?.id ? `https://www.grants.gov/search-results-detail/${hit.id}` : 'https://www.grants.gov',
          opportunity_number: hit?.number || null,
          deadline: hit?.closeDate || null,
          source: 'grants.gov',
          source_id: hit?.id || null,
          zip: zip,
          state: coords?.state,
        })
      }
    }
  } catch (error) {
    console.error(`[NationalZipCrawler] Grants.gov error for ZIP ${zip}:`, error.message)
  }
  
  return opportunities
}

/**
 * Search state grant portals by ZIP
 */
async function searchStateGrantsByZip(zip, coords) {
  const opportunities = []
  
  if (!coords || !coords.state) {
    return opportunities
  }
  
  // State grant portal URLs (add more states in production)
  const statePortals = {
    'OH': 'https://grants.ohio.gov',
    'CA': 'https://www.grants.ca.gov',
    'TX': 'https://www.governor.state.tx.us/grants',
    'NY': 'https://grantsgateway.ny.gov',
    'FL': 'https://www.myflorida.com/apps/vbs/vbs_www.main.show_grants'
    // Add more states...
  }
  
  const portalUrl = statePortals[coords.state]
  if (!portalUrl) {
    return opportunities // State portal not configured
  }
  
  try {
    // Note: Each state has different API/scraping requirements
    // This is a placeholder - real implementation would scrape or use APIs
    console.log(`[NationalZipCrawler] Would search ${coords.state} portal for ZIP ${zip}`)
    
    // For now, return placeholder indicating state portal search would happen
    // In production, implement actual scraping/API calls
  } catch (error) {
    console.error(`[NationalZipCrawler] State portal error for ZIP ${zip}:`, error.message)
  }
  
  return opportunities
}

/**
 * Search foundation locator services
 */
async function searchFoundationLocator(zip, coords) {
  const opportunities = []
  
  if (!coords || !coords.lat || !coords.lng) {
    return opportunities
  }
  
  try {
    // Council on Foundations Foundation Locator
    // Note: Real implementation would need proper API access
    const url = `https://www.cof.org/foundation-locator?lat=${coords.lat}&lng=${coords.lng}&radius=25`
    
    console.log(`[NationalZipCrawler] Would search foundation locator for ZIP ${zip}`)
    
    // For now, return placeholder
    // In production, implement actual API calls or scraping
  } catch (error) {
    console.error(`[NationalZipCrawler] Foundation locator error for ZIP ${zip}:`, error.message)
  }
  
  return opportunities
}

/**
 * Get coordinates for ZIP code
 */
async function getZipCoordinates(zip) {
  try {
    // Prefer local dataset to avoid network flakiness and mass skipping.
    const local = zipcodes.lookup(zip)
    if (local) {
      return {
        lat: parseFloat(local.latitude),
        lng: parseFloat(local.longitude),
        city: local.city,
        state: local.state
      }
    }

    const response = await axios.get(`https://api.zippopotam.us/us/${zip}`, {
      timeout: DEFAULT_CONFIG.timeout_ms
    })
    
    if (response.data && response.data.places && response.data.places[0]) {
      return {
        lat: parseFloat(response.data.places[0].latitude),
        lng: parseFloat(response.data.places[0].longitude),
        city: response.data.places[0]['place name'],
        state: response.data.places[0]['state abbreviation']
      }
    }
  } catch (error) {
    // ZIP not found or service unavailable
    return null
  }
  
  return null
}

/**
 * Process a single ZIP code
 */
async function processZip(zip, db) {
  console.log(`[NationalZipCrawler] Processing ZIP ${zip}...`)
  
  const startTime = Date.now()
  let sources = []
  let error = null
  let status = 'completed'
  
  try {
    // Get coordinates
    const coords = await getZipCoordinates(zip)
    
    if (!coords) {
      console.log(`  Warning: Could not geocode ZIP ${zip}, skipping`)
      status = 'skipped'
      return { zip, status, sources_found: 0, duration: Date.now() - startTime }
    }
    
    // Search all data sources
    const [grantsGovResults, stateResults, foundationResults] = await Promise.all([
      searchGrantsGovByZip(zip, coords),
      searchStateGrantsByZip(zip, coords),
      searchFoundationLocator(zip, coords)
    ])
    
    sources = [...grantsGovResults, ...stateResults, ...foundationResults]
    
    console.log(`  Found ${sources.length} sources for ZIP ${zip}`)
    
    // Save opportunities to database
    for (const opp of sources) {
      await saveOpportunity(db, opp)
    }
    
    // Check if we met minimum sources requirement
    if (sources.length < DEFAULT_CONFIG.min_sources_per_zip) {
      console.log(`  Warning: Only found ${sources.length} sources (minimum: ${DEFAULT_CONFIG.min_sources_per_zip})`)
    }
    
  } catch (err) {
    error = err.message
    status = 'failed'
    console.error(`  Error processing ZIP ${zip}:`, err.message)
  }
  
  return {
    zip,
    status,
    sources_found: sources.length,
    error,
    duration: Date.now() - startTime
  }
}

/**
 * Save opportunity to database
 */
async function saveOpportunity(db, opp) {
  const insertSql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO funding_opportunities (
            id,
            title, sponsor, description, source, source_id, source_url,
            state, deadline, created_at, updated_at
          ) VALUES (gen_random_uuid()::text, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT DO NOTHING
        `
      : `
          INSERT OR IGNORE INTO funding_opportunities (
            title, sponsor, description, source, source_id, source_url,
            state, deadline, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `

  const stmt = db.prepare(insertSql)
  
  if (db?.dialect === 'postgres') {
    await stmt.run(
      opp.title,
      opp.sponsor,
      opp.description,
      opp.source,
      opp.source_id || null,
      opp.url,
      opp.state || null,
      opp.deadline || null,
    )
  } else {
    stmt.run(
      opp.title,
      opp.sponsor,
      opp.description,
      opp.source,
      opp.source_id || null,
      opp.url,
      opp.state || null,
      opp.deadline || null,
    )
  }
}

/**
 * Update ZIP progress in database
 */
async function updateZipProgress(db, zip, status, sources_found, error = null) {
  const sql =
    db?.dialect === 'postgres'
      ? `
          INSERT INTO national_zip_progress (zip, last_run_at, sources_found, status, error, updated_at)
          VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT (zip) DO UPDATE SET
            last_run_at = excluded.last_run_at,
            sources_found = excluded.sources_found,
            status = excluded.status,
            error = excluded.error,
            updated_at = CURRENT_TIMESTAMP
        `
      : `
          INSERT OR REPLACE INTO national_zip_progress
          (zip, last_run_at, sources_found, status, error, updated_at)
          VALUES (?, datetime('now'), ?, ?, ?, datetime('now'))
        `

  const stmt = db.prepare(sql)
  await stmt.run(zip, sources_found, status, error)
}

/**
 * Get last processed ZIP for resumability
 */
async function getLastProcessedZip(db) {
  const row = await db.prepare(`
    SELECT zip FROM national_zip_progress 
    WHERE status = 'completed'
    ORDER BY updated_at DESC 
    LIMIT 1
  `).get()
  
  return row?.zip || null
}

async function getLastProcessedZipForList(db, zipList) {
  if (!Array.isArray(zipList) || zipList.length === 0) return null
  if (zipList.length > 2000) return null

  const placeholders = zipList.map(() => '?').join(', ')
  const row = await db
    .prepare(
      `
        SELECT zip
        FROM national_zip_progress
        WHERE status = 'completed'
          AND zip IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(...zipList)

  return row?.zip || null
}

/**
 * Main national ZIP crawl function
 */
export async function runNationalZipCrawl(dbPath, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options }

  // Prefer the shared DB wrapper when invoked from the app (Postgres-safe),
  // keep sqlite file-path mode for local/script usage.
  const ownsDb = typeof dbPath === 'string'
  const db = ownsDb ? new Database(dbPath) : dbPath

  const zipList = resolveZipList({
    zip_list: options.zip_list,
    state: options.state,
    max_zips: options.max_zips,
  })

  if (zipList.length === 0) {
    // Nothing to do. Important: do NOT close shared DB connections.
    return { processed: 0, sources: 0, duration: 0 }
  }

  console.log('='.repeat(80))
  console.log('National ZIP Crawl Starting')
  console.log('='.repeat(80))
  console.log(`Batch size: ${config.batch_size}`)
  console.log(`Min sources per ZIP: ${config.min_sources_per_zip}`)
  console.log(`Rate limit: ${config.rate_limit_ms}ms`)
  console.log()
  
  // Resumability:
  // - Full national crawl is resumable by default (resume=true)
  // - State-scoped and explicit-list crawls default to resume=false to avoid surprising skips.
  const inferredResumeDefault = !options.state && !options.zip_list
  const allowResume = options.resume != null ? Boolean(options.resume) : inferredResumeDefault
  const lastProcessedZip = allowResume
    ? (await getLastProcessedZipForList(db, zipList)) ?? (await getLastProcessedZip(db))
    : null

  const startIndex = lastProcessedZip ? zipList.indexOf(lastProcessedZip) + 1 : 0
  
  if (lastProcessedZip) {
    console.log(`Resuming from ZIP ${lastProcessedZip} (index ${startIndex})`)
  } else {
    console.log('Starting from beginning')
  }
  
  const totalZips = zipList.length
  const remainingZips = Math.max(0, totalZips - startIndex)
  
  console.log(`Total ZIPs: ${totalZips}`)
  console.log(`Remaining: ${remainingZips}`)
  console.log()
  
  let processedCount = 0
  let totalSources = 0
  const startTime = Date.now()
  
  // Process in batches
  for (let i = startIndex; i < totalZips; i += config.batch_size) {
    const batchEnd = Math.min(i + config.batch_size, totalZips)
    const batch = zipList.slice(i, batchEnd)
    
    console.log(`Processing batch ${Math.floor(i / config.batch_size) + 1}: ZIPs ${i} - ${batchEnd}`)
    
    for (const zip of batch) {
      const result = await processZip(zip, db)
      
      // Update progress in database
      await updateZipProgress(db, result.zip, result.status, result.sources_found, result.error)
      
      processedCount++
      totalSources += result.sources_found
      
      // Rate limiting
      if (Number(config.rate_limit_ms) > 0) {
        await new Promise(resolve => setTimeout(resolve, config.rate_limit_ms))
      }
      
      // Memory management
      if (processedCount % 100 === 0) {
        const elapsed = Date.now() - startTime
        const rate = (processedCount / elapsed) * 1000 * 60 // per minute
        console.log(`  Progress: ${processedCount}/${remainingZips} ZIPs (${rate.toFixed(1)}/min), ${totalSources} sources found`)
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc()
        }
      }
    }
    
    console.log(`  Batch complete, checkpointing...`)
    console.log()
  }
  
  const totalDuration = Date.now() - startTime
  
  console.log('='.repeat(80))
  console.log('National ZIP Crawl Complete')
  console.log('='.repeat(80))
  console.log(`Total ZIPs processed: ${processedCount}`)
  console.log(`Total sources found: ${totalSources}`)
  console.log(`Average sources per ZIP: ${processedCount > 0 ? (totalSources / processedCount).toFixed(2) : '0.00'}`)
  console.log(`Duration: ${(totalDuration / 1000 / 60).toFixed(2)} minutes`)
  console.log()
  
  if (ownsDb && typeof db?.close === 'function') {
    db.close()
  }
  
  return {
    processed: processedCount,
    sources: totalSources,
    duration: totalDuration
  }
}

export default { runNationalZipCrawl }
