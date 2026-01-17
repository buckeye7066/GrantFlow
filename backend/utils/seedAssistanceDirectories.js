import crypto from 'crypto'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function loadJSON(path) {
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

export function seedAssistanceDirectories(db) {
  const dataDir = join(__dirname, '..', 'data')
  const statePrograms = loadJSON(join(dataDir, 'state_assistance_programs.json'))
  const localNetworks = loadJSON(join(dataDir, 'local_assistance_networks.json'))

  const programs = ensureArray(statePrograms?.programs)
  const networks = ensureArray(localNetworks?.networks)

  let attempted = 0

  const upsertOne = (item, source) => {
    const url = item?.url || item?.source_url || item?.application_url
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

    upsertFundingOpportunity(db, opportunity)
  }

  for (const p of programs) {
    attempted++
    try {
      upsertOne(p, 'state_211')
    } catch (e) {
      // ignore per item
    }
  }

  for (const n of networks) {
    attempted++
    try {
      upsertOne(n, 'assistance_network')
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

