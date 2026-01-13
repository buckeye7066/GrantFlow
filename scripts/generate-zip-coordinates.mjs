#!/usr/bin/env node
/**
 * Generates backend/data/crawlers/zip_coordinates.json with every US ZIP code.
 * Requires the `zipcodes` package (installed via npm install zipcodes).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zipcodes from 'zipcodes'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const outputPath = path.resolve(projectRoot, 'backend', 'data', 'crawlers', 'zip_coordinates.json')

const result = {}
Object.keys(zipcodes.codes).forEach((zip) => {
  const entry = zipcodes.codes[zip]
  if (!entry?.zip || !entry?.latitude || !entry?.longitude) {
    return
  }

  result[entry.zip] = {
    lat: Number(entry.latitude),
    lng: Number(entry.longitude),
    city: entry.city || null,
    state: entry.state || null,
  }
})

const sortedKeys = Object.keys(result).sort((a, b) => Number(a) - Number(b))
const sortedResult = {}
sortedKeys.forEach((zip) => {
  sortedResult[zip] = result[zip]
})

fs.writeFileSync(outputPath, `${JSON.stringify(sortedResult, null, 2)}\n`, 'utf8')

console.log(`[zip-generator] Wrote ${sortedKeys.length} ZIP codes to ${outputPath}`)
