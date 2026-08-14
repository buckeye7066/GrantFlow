import crypto from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const missingOnce = new Set()

function loadJSON(path) {
  if (!existsSync(path)) {
    if (!missingOnce.has(path)) {
      missingOnce.add(path)
      console.info(
        `[seedAssistanceDirectories] Seed file not found; skipping: ${path} (expected in backend/data/)`,
      )
    }
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // Missing seed files are expected in many environments (e.g. production images, fresh clones).
    // Only warn on non-ENOENT failures (e.g. invalid JSON).
    if (error?.code !== 'ENOENT') {
      console.warn('[seedAssistanceDirectories] Could not load ' + path + ':', error?.message || String(error))
    }
    return null
  }
}


function stableIdFromUrl(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex')
}

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

export async function seedAssistanceDirectories(db) {
  const dataDir = join(__dirname, '..', 'data')
  const stateProgramsPath = join(dataDir, 'state_assistance_programs.json')
  const localNetworksPath = join(dataDir, 'local_assistance_networks.json')

  const statePrograms = loadJSON(stateProgramsPath)
  const localNetworks = loadJSON(localNetworksPath)

  const programs = ensureArray(statePrograms?.programs)
  const networks = ensureArray(localNetworks?.networks)

  let attempted = 0

  let skipped = 0

const upsertOne = async (item, source) => {
  const url = item?.url || item?.source_url || item?.application_url || item?.evidence_url
  if (!url) {
    skipped++
    console.warn(
      `[seedAssistanceDirectories] Skipping record with no URL (source=${source}, title=${item?.title || item?.name || 'unknown'}) — violates Goal 1 (no application path)`,
    )
    return
  }

    const isNational = Boolean(item?.is_national) || item?.state === 'nationwide'
    const state = item?.state || (isNational ? 'nationwide' : null)
    const id = item?.id || stableIdFromUrl(url)

    const opportunity = {
      id,
      source,
      source_id: id,
      title: item?.title || item?.name || 'Assistance program',
      sponsor: item?.sponsor || item?.administering_agency || null,
      description: item?.description || null,
      application_url: url,
      source_url: url,
      is_national: isNational ? 1 : 0,
      state,
      categories: ensureArray(item?.categories),
      keywords: ensureArray(item?.keywords),
      eligibility_bullets: ensureArray(item?.eligibility_bullets),
      opportunity_type: item?.opportunity_type || 'program',
      type: item?.type || (item?.is_national ? 'DIRECTORY' : 'PROGRAM'),
      requires_match: 0,
      requires_501c3: 0,
      record_origin: 'curated_verified',
    }

    // upsertFundingOpportunity is the correct call for the opportunity catalogue (not the user pipeline).
// However the record MUST be validated before insertion:
// 1. URL must be non-empty and well-formed before reaching the DB (Goal 1).
// 2. The opportunity must pass relevanceFilter before catalogue insertion (Goal 3).
// 3. Audit fields must be stamped so re-evaluation is possible (Goals 8, 9).
//
// Apply URL validation and stamp provenance metadata here:
if (!url || !/^https?:\/\/.+/.test(url)) return  // Goal 1: reject records with no real application path

const catalogueRecord = {
  ...opportunity,
  record_origin: 'curated_verified',
  matcher_version: null,   // not yet matched to a profile; set at match time
  evaluated_at: null,      // set when match engine runs
  inserted_at: new Date().toISOString(),
}
await upsertFundingOpportunity(db, catalogueRecord)
  }

  for (const p of programs) {
    attempted++
    try {
      await upsertOne(p, 'state_211')
    } catch (e) {
      console.warn(
        `[seedAssistanceDirectories] Failed to upsert state program (title=${p?.title || p?.name || 'unknown'}): ${e?.message || String(e)}`,
      )
    }
  }

  for (const n of networks) {
    attempted++
    try {
      await upsertOne(n, 'assistance_network')
    } catch (e) {
      console.warn(
        `[seedAssistanceDirectories] Failed to upsert network record (title=${n?.title || n?.name || 'unknown'}): ${e?.message || String(e)}`,
      )
    }
  }

  return {
    attempted,
    skipped,          // records dropped because no application URL
    state_programs: programs.length,
    networks: networks.length,
  }
}

export default seedAssistanceDirectories

