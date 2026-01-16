#!/usr/bin/env node
/**
 * Phase 7 helper: inventory Base44 compatibility surface area used by the UI.
 *
 * Scans the `src/` tree for:
 * - base44.entities.<EntityName>
 * - base44.functions.invoke('<functionName>')
 * - base44.integrations.Core.<MethodName>
 *
 * Usage:
 *   node scripts/base44-usage-report.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const SRC_DIR = path.join(ROOT, 'src')

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      // eslint-disable-next-line no-await-in-loop
      yield* walk(full)
    } else {
      if (!/\.(jsx?|tsx?)$/i.test(entry.name)) continue
      yield full
    }
  }
}

function addToMap(map, key, file) {
  if (!key) return
  const set = map.get(key) ?? new Set()
  set.add(file)
  map.set(key, set)
}

function mapToSortedObject(map) {
  const obj = {}
  Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([k, files]) => {
      obj[k] = Array.from(files).sort()
    })
  return obj
}

async function run() {
  const entities = new Map()
  const functions = new Map()
  const integrations = new Map()

  for await (const file of walk(SRC_DIR)) {
    // eslint-disable-next-line no-await-in-loop
    const content = await fs.readFile(file, 'utf8')
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')

    for (const match of content.matchAll(/\bbase44\.entities\.([A-Za-z0-9_]+)/g)) {
      addToMap(entities, match[1], rel)
    }

    for (const match of content.matchAll(/\bbase44\.functions\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) {
      addToMap(functions, match[1], rel)
    }

    for (const match of content.matchAll(/\bbase44\.integrations\.Core\.([A-Za-z0-9_]+)/g)) {
      addToMap(integrations, match[1], rel)
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    entities: mapToSortedObject(entities),
    functions: mapToSortedObject(functions),
    integrations: mapToSortedObject(integrations),
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2))

  const outDir = path.join(ROOT, 'artifacts', 'local', new Date().toISOString().slice(0, 10))
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, 'base44-usage-report.json')
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8')
  // eslint-disable-next-line no-console
  console.log(`\n[base44-usage-report] wrote ${path.relative(ROOT, outPath).replace(/\\/g, '/')}`)
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[base44-usage-report] failed:', e instanceof Error ? e.stack : e)
  process.exitCode = 1
})

