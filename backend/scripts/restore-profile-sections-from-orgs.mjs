/**
 * Restore profile_sections from linked organizations (fills empty / default sections).
 *
 * Usage:
 *   node backend/scripts/restore-profile-sections-from-orgs.mjs
 *   DRY_RUN=1 node backend/scripts/restore-profile-sections-from-orgs.mjs
 *
 * Uses the same DB connection as the API (`backend/db/index.js`).
 */

import { db } from '../db/index.js'
import { restoreProfileSectionsFromLinkedOrganizations } from '../services/profileOrganizationSync.js'

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : undefined

  const result = await restoreProfileSectionsFromLinkedOrganizations(db, {
    dryRun,
    limit,
  })

  console.log(JSON.stringify(result, null, 2))

  try {
    await db.close?.()
  } catch {
    // ignore
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[restore-profile-sections-from-orgs]', err)
  process.exitCode = 1
})
