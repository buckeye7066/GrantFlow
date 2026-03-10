#!/usr/bin/env node
/**
   * cleanup-funding-opportunities.mjs
   *
   * ONE-TIME MIGRATION: Deactivates contaminated records in funding_opportunities.
   *
   * ROOT CAUSE: Previous crawler implementations stored informational pages
   * (CDC Health Topics, MedlinePlus, NeedyMeds, Patient Advocate Foundation,
   * Medicaid contact directories, 211.org, etc.) as "funding opportunities."
   * These are NOT real funding sources — they are informational websites and
   * resource directories that do not provide actual money or direct assistance.
   *
   * This script:
   * 1. Deactivates (is_active = false) all records that don't have a trusted record_origin
   * 2. Deactivates records matching known informational patterns
   * 3. Reports what was cleaned up
   *
   * Run: node backend/scripts/cleanup-funding-opportunities.mjs
   *
   * Safe to run multiple times (idempotent).
   */

import pg from 'pg'
import { UNTRUSTED_ORIGINS } from '../utils/recordOrigins.js'
const { Client } = pg

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required')
    console.error('Set it to your Railway PostgreSQL connection string')
    process.exit(1)
}

// Blocklist approach: deactivate only explicitly untrusted origins (from shared module).
// All other origins (including new crawler types) are considered valid.

const INFORMATIONAL_TITLE_PATTERNS = [
    '%health topics%',
    '%health information%',
    '%medlineplus%',
    '%health library%',
    '%medical encyclopedia%',
    '%disease information%',
    '%patient education%',
    '%disease fact sheet%',
    '%contact your state%',
    '%find a doctor%',
    '%find a clinic%',
    '%find local help%',
    '%connect to help%',
    '%state contact directory%',
    '%office locator%',
    '%provider directory%',
  ]

const INFORMATIONAL_URL_PATTERNS = [
    '%cdc.gov/topics%',
    '%cdc.gov/ncbddd%',
    '%medlineplus.gov%',
    '%mayoclinic.org%',
    '%webmd.com%',
    '%healthline.com%',
    '%wikipedia.org%',
    '%nih.gov/health%',
  ]

async function main() {
    const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
    await client.connect()
    console.log('Connected to database')

  try {
        // Step 1: Count current state
      const totalRes = await client.query('SELECT COUNT(*) as count FROM funding_opportunities')
        const activeRes = await client.query('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = true')
        console.log(`\nCurrent state: ${totalRes.rows[0].count} total, ${activeRes.rows[0].count} active\n`)

      // Step 2: Deactivate records with explicitly untrusted origins (blocklist)
      const originPlaceholders = UNTRUSTED_ORIGINS.map((_, i) => `$${i + 1}`).join(',')
        const untrustedRes = await client.query(
                `UPDATE funding_opportunities
                       SET is_active = false
                              WHERE is_active = true
                                       AND record_origin IN (${originPlaceholders})
                                              RETURNING id, title, record_origin, source`,
                UNTRUSTED_ORIGINS
              )
        console.log(`Deactivated ${untrustedRes.rowCount} records with untrusted record_origin:`)
        for (const row of untrustedRes.rows.slice(0, 20)) {
                console.log(`  - [${row.record_origin || 'NULL'}] ${row.title?.substring(0, 60)}`)
        }
        if (untrustedRes.rowCount > 20) {
                console.log(`  ... and ${untrustedRes.rowCount - 20} more`)
        }

      // Step 3: Deactivate records matching informational title patterns
      for (const pattern of INFORMATIONAL_TITLE_PATTERNS) {
              const res = await client.query(
                        `UPDATE funding_opportunities
                                 SET is_active = false
                                          WHERE is_active = true
                                                     AND LOWER(title) LIKE $1
                                                              RETURNING id, title`,
                        [pattern]
                      )
              if (res.rowCount > 0) {
                        console.log(`\nDeactivated ${res.rowCount} records matching title pattern "${pattern}":`)
                        for (const row of res.rows) {
                                    console.log(`  - ${row.title?.substring(0, 60)}`)
                        }
              }
      }

      // Step 4: Deactivate records matching informational URL patterns
      for (const pattern of INFORMATIONAL_URL_PATTERNS) {
              const res = await client.query(
                        `UPDATE funding_opportunities
                                 SET is_active = false
                                          WHERE is_active = true
                                                     AND (LOWER(url) LIKE $1 OR LOWER(source_url) LIKE $1 OR LOWER(application_url) LIKE $1)
                                                              RETURNING id, title, url`,
                        [pattern]
                      )
              if (res.rowCount > 0) {
                        console.log(`\nDeactivated ${res.rowCount} records matching URL pattern "${pattern}":`)
                        for (const row of res.rows) {
                                    console.log(`  - ${row.title?.substring(0, 50)} (${row.url?.substring(0, 50)})`)
                        }
              }
      }

      // Step 5: Report final state
      const finalActiveRes = await client.query('SELECT COUNT(*) as count FROM funding_opportunities WHERE is_active = true')
        const finalTrustedRes = await client.query(
                `SELECT record_origin, COUNT(*) as count
                       FROM funding_opportunities
                              WHERE is_active = true
                                     GROUP BY record_origin
                                            ORDER BY count DESC`
              )

      console.log(`\n${'='.repeat(60)}`)
        console.log(`CLEANUP COMPLETE`)
        console.log(`${'='.repeat(60)}`)
        console.log(`Active records: ${activeRes.rows[0].count} -> ${finalActiveRes.rows[0].count}`)
        console.log(`\nActive records by origin:`)
        for (const row of finalTrustedRes.rows) {
                console.log(`  ${row.record_origin || 'NULL'}: ${row.count}`)
        }
  } finally {
        await client.end()
  }
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exit(1)
})
