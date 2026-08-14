#!/usr/bin/env node
/**
 * regional-purge.mjs
 *
 * CLI entry point for the regional purge system.
 *
 * Usage:
 *   node backend/scripts/regional-purge.mjs [options]
 *
 * Options:
 *   --dry-run           Do not write any DB changes (report only)
 *   --states=TN,OH      Comma-separated list of 2-letter state codes.
 *                       If omitted, states are auto-discovered from active profiles.
 *   --limit=500         Maximum number of opportunities to check (default: 500)
 *
 * Exit codes:
 *   0 – success (including dry-run)
 *   1 – fatal failure
 */

import { getDb } from '../db/index.js'
import {
  runRegionalPurge,
  discoverActiveProfileStates,
  ensureSuppressionSchema,
} from '../services/regionalPurgeService.js'

// ─── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getFlag(name) {
  const flag = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!flag) return null
  if (flag.includes('=')) return flag.split('=').slice(1).join('=')
  return true
}

const dryRun = Boolean(getFlag('dry-run'))
const statesArg = getFlag('states')
const limitArg = getFlag('limit')

const states = statesArg && typeof statesArg === 'string'
  ? statesArg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : undefined

const limit = limitArg && !isNaN(Number(limitArg)) ? Number(limitArg) : 500

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║         GrantFlow — Regional Purge System            ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log('')

  let db
  try {
    db = getDb()
  } catch (err) {
    console.error('[regional-purge] FATAL: Could not connect to database:', err?.message)
    process.exit(1)
  }

  // Ensure suppression schema is present
  try {
    await ensureSuppressionSchema(db)
  } catch (err) {
    console.error('[regional-purge] FATAL: Failed to initialise suppression schema:', err?.message)
    process.exit(1)
  }

  // Discover states if not explicitly provided
  let targetStates = states
  if (!targetStates || targetStates.length === 0) {
    try {
      targetStates = await discoverActiveProfileStates(db)
    } catch (err) {
      console.error('[regional-purge] FATAL: Failed to discover states:', err?.message)
      process.exit(1)
    }
  }

  console.log('Mode      :', dryRun ? 'DRY RUN (no DB mutations)' : 'LIVE RUN')
  console.log('States    :', targetStates.length > 0 ? targetStates.join(', ') : '(none found)')
  console.log('Limit     :', limit)
  console.log('')

  if (targetStates.length === 0) {
    console.warn('[regional-purge] No target states found. Nothing to do.')
    process.exit(0)
  }

  let result
  try {
    result = await runRegionalPurge(db, { dryRun, states: targetStates, limit })
  } catch (err) {
    console.error('[regional-purge] FATAL: Purge run failed:', err?.message || err)
    process.exit(1)
  }

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════')
  console.log('SUMMARY')
  console.log('══════════════════════════════════════════════════════')
  console.log(`States processed : ${result.statesProcessed.join(', ')}`)
  console.log(`Checked          : ${result.checked}`)
  console.log(`  → active       : ${result.active}`)
  console.log(`  → watch        : ${result.watch}`)
  console.log(`  → suppressed   : ${result.suppressed}`)
  console.log(`  → errors       : ${result.errors}`)
  console.log('')

  if (Object.keys(result.perState).length > 0) {
    console.log('Per-state breakdown:')
    for (const [st, s] of Object.entries(result.perState)) {
      console.log(
        `  ${st.padEnd(4)} checked=${s.checked}  active=${s.active}  watch=${s.watch}  suppressed=${s.suppressed}  errors=${s.errors}`,
      )
    }
    console.log('')
  }

  if (result.errors > 0) {
    console.warn(`[regional-purge] Completed with ${result.errors} error(s).`)
    process.exit(0) // Errors are non-fatal per-opportunity; overall run succeeded.
  }

  console.log('[regional-purge] Done.')
  process.exit(0)
}

main()
