#!/usr/bin/env node
/**
 * Phase 7 helper: summarize a Base44 export file (entities + counts).
 *
 * Usage:
 *   node scripts/base44-export-report.mjs path/to/data-export.json
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

async function run() {
  const filePath = process.argv[2]
  if (!filePath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/base44-export-report.mjs path/to/data-export.json')
    process.exitCode = 2
    return
  }

  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath)
  const raw = await fs.readFile(abs, 'utf8')
  const exportData = JSON.parse(raw)

  const entityCounts = {}
  const entities = exportData?.entities && typeof exportData.entities === 'object' ? exportData.entities : {}
  for (const [name, rows] of Object.entries(entities)) {
    entityCounts[name] = Array.isArray(rows) ? rows.length : 0
  }

  const report = {
    generated_at: new Date().toISOString(),
    source_file: abs,
    has_entities: !!exportData?.entities,
    entity_counts: Object.fromEntries(Object.entries(entityCounts).sort((a, b) => a[0].localeCompare(b[0]))),
    top_level_keys: Object.keys(exportData || {}).sort(),
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2))
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[base44-export-report] failed:', e instanceof Error ? e.stack : e)
  process.exitCode = 1
})

