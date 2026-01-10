import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ZIP_COORDS_PATH = join(__dirname, '..', '..', 'data', 'crawlers', 'zip_coordinates.json')

let cached = null

function loadZipCoordinates() {
  if (cached) return cached
  const raw = fs.readFileSync(ZIP_COORDS_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  cached = parsed
  return parsed
}

export function listStatesWithCounts() {
  const zipMap = loadZipCoordinates()
  const counts = new Map()
  Object.entries(zipMap).forEach(([zip, entry]) => {
    const state = entry?.state
    if (!state) return
    counts.set(state, (counts.get(state) ?? 0) + 1)
  })
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, zip_count]) => ({ state, zip_count }))
}

export function listZipsForState(state) {
  const zipMap = loadZipCoordinates()
  const normalized = String(state || '').trim().toUpperCase()
  if (!normalized) return []
  const results = []
  Object.entries(zipMap).forEach(([zip, entry]) => {
    if (!entry || entry.state !== normalized) return
    results.push({
      zip_code: zip,
      city: entry.city ?? null,
      state: entry.state ?? null,
      lat: typeof entry.lat === 'number' ? entry.lat : null,
      lng: typeof entry.lng === 'number' ? entry.lng : null,
    })
  })
  results.sort((a, b) => a.zip_code.localeCompare(b.zip_code))
  return results
}

export function getZipEntry(zip) {
  const zipMap = loadZipCoordinates()
  const key = String(zip || '').trim()
  const entry = zipMap[key]
  if (!entry) return null
  return {
    zip_code: key,
    city: entry.city ?? null,
    state: entry.state ?? null,
    lat: typeof entry.lat === 'number' ? entry.lat : null,
    lng: typeof entry.lng === 'number' ? entry.lng : null,
  }
}

