// scripts/amy-train.mjs
//
// Amy — synthetic crawler-training agent (CLI harness).
//
// Generates highly varied SYNTHETIC GrantFlow profiles (no real PII), runs them
// through the REAL Crawler-OS discovery seam, measures crawler success/failure,
// writes an Anya handoff report, and (by default) cleans up the synthetic
// profiles it created. Every profile is tagged so Sam can delete it later.
//
// Usage:
//   node scripts/amy-train.mjs                         # all categories, 1 each, discovery dry-run, auto-cleanup
//   node scripts/amy-train.mjs --count=100                # exactly 100 profiles spread across categories
//   node scripts/amy-train.mjs --per-category=2
//   node scripts/amy-train.mjs --categories=veteran,nonprofit,cancer_patient
//   node scripts/amy-train.mjs --keep-profiles         # leave profiles for Sam's sweep
//   node scripts/amy-train.mjs --persist               # actually flush discovery to the live catalog (NOT default)
//   node scripts/amy-train.mjs --floor=50 --ttl=48
//   node scripts/amy-train.mjs --list-categories
//
// Artifacts are written under audit-reports/ (gitignored):
//   amy-to-anya-handoff-<runId>.json   (Anya-consumable findings report)
//   amy-run-<runId>.json               (full per-scenario run log)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../backend/db/index.js'
import { runAmyTraining } from '../backend/services/amy/amyAgent.js'
import { CATEGORY_IDS, CATEGORY_CATALOG } from '../backend/services/amy/syntheticProfileCatalog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

function getFlag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}

async function makeArtifactWriter() {
  const dir = path.join(repoRoot, 'audit-reports')
  await fs.mkdir(dir, { recursive: true })
  return async (relName, jsonStr) => {
    const full = path.join(dir, relName)
    await fs.writeFile(full, jsonStr, 'utf8')
    return path.relative(repoRoot, full)
  }
}

async function main() {
  if (getFlag('list-categories')) {
    console.log('Amy synthetic profile categories:')
    for (const id of CATEGORY_IDS) console.log(`  ${id.padEnd(28)} ${CATEGORY_CATALOG[id].label}`)
    return
  }

  const categoriesArg = getFlag('categories')
  const categories = typeof categoriesArg === 'string' ? categoriesArg.split(',').map((s) => s.trim()).filter(Boolean) : CATEGORY_IDS
  const perCategory = Number(getFlag('per-category')) || 1
  const targetCount = getFlag('count') !== undefined ? Number(getFlag('count')) : null
  const keepProfiles = Boolean(getFlag('keep-profiles'))
  const persist = Boolean(getFlag('persist'))
  const floor = getFlag('floor') !== undefined ? Number(getFlag('floor')) : undefined
  const ttlHours = getFlag('ttl') !== undefined ? Number(getFlag('ttl')) : 48

  const db = getDb()
  const writeArtifact = await makeArtifactWriter()

  console.log(`[amy] starting training run: ${targetCount ? `target=${targetCount} profiles` : `categories=${categories.length} per_category=${perCategory}`} ` +
    `discovery=${persist ? 'PERSIST' : 'dry-run'} keep_profiles=${keepProfiles}`)

  const out = await runAmyTraining({
    db,
    categories,
    perCategory,
    targetCount,
    dryRunDiscovery: !persist,
    floor,
    keepProfiles,
    ttlHours,
    writeArtifact,
  })

  const s = out.summary
  console.log(`[amy] run ${out.run_id} complete`)
  console.log(`[amy] scenarios=${s.scenarios} ok=${s.ok} weak=${s.weak} zero=${s.zero} skipped=${s.skipped} error=${s.error} findings=${s.total_findings}`)
  console.log(`[amy] handoff: ${out.artifacts.handoffPath || '(not written)'}`)
  console.log(`[amy] run log: ${out.artifacts.runLogPath || '(not written)'}`)
  if (out.kept_profiles) {
    console.log(`[amy] kept ${out.created_profile_ids.length} synthetic profile(s) for Sam cleanup (run: npm run amy:cleanup -- --run=${out.run_id})`)
  } else {
    console.log(`[amy] cleaned up ${out.cleanup?.deleted ?? 0} synthetic profile(s)`) }
}

main().catch((e) => { console.error('[amy] ERROR', e); process.exit(1) })
