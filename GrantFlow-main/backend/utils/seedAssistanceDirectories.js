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

  const upsertOne = async (item, source) => {
    const url = item?.url || item?.source_url || item?.application_url || item?.evidence_url
    if (!url) return

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

    await upsertFundingOpportunity(db, opportunity)
  }

  for (const p of programs) {
    attempted++
    try {
      await upsertOne(p, 'state_211')
    } catch (e) {
      // ignore per item
    }
  }

  for (const n of networks) {
    attempted++
    try {
      await upsertOne(n, 'assistance_network')
    } catch (e) {
      // ignore per item
    }
  }

  return {
    attempted,
    state_programs: programs.length,
    networks: networks.length,
  }
}

export default seedAssistanceDirectories

