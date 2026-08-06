/**
 * Read-only production preflight for migration 0167.
 *
 * Run this against the intended PostgreSQL release database before applying
 * the Hamilton status CHECK migration. Any unknown persisted state would make
 * PostgreSQL reject the new validated constraint and must be investigated,
 * never rewritten automatically by a release script.
 */

import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  APPLICATION_TASK_STATUSES,
} from '../db/migrations/163_hamilton_submission_attempt_states.mjs'

export const APPLICATION_TASK_STATUS_COUNTS_SQL = `
  SELECT status, COUNT(*)::bigint AS task_count
  FROM application_tasks
  GROUP BY status
  ORDER BY status
`

export function assessApplicationTaskStatusCounts(rows) {
  const expected = new Set(APPLICATION_TASK_STATUSES)
  const counts = (Array.isArray(rows) ? rows : []).map((row) => ({
    status: String(row?.status ?? ''),
    taskCount: String(row?.task_count ?? row?.taskCount ?? '0'),
  }))
  const unexpected = counts.filter(({ status }) => !expected.has(status))
  return { counts, unexpected }
}

export async function preflightApplicationTaskStatuses(db) {
  if (db?.dialect !== 'postgres') {
    return {
      counts: [],
      unexpected: [],
      wrongDialect: true,
      error: `expected a postgres DB, got dialect=${db?.dialect ?? 'unknown'}`,
    }
  }
  const rows = await db.prepare(APPLICATION_TASK_STATUS_COUNTS_SQL).all()
  return {
    ...assessApplicationTaskStatusCounts(rows),
    wrongDialect: false,
    error: null,
  }
}

async function runCli() {
  const { getDb } = await import('../db/index.js')
  const db = getDb()
  try {
    const result = await preflightApplicationTaskStatuses(db)
    if (result.error) {
      console.error(`[preflight-pg-application-task-statuses] ${result.error}`)
      return 2
    }

    console.log('[preflight-pg-application-task-statuses] persisted status counts:')
    if (result.counts.length === 0) console.log('  (no application_tasks rows)')
    for (const row of result.counts) {
      console.log(`  ${row.status}: ${row.taskCount}`)
    }

    if (result.unexpected.length > 0) {
      console.error(
        `[preflight-pg-application-task-statuses] BLOCKED — unknown states: ${result.unexpected.map((row) => row.status || '<empty>').join(', ')}`,
      )
      return 1
    }
    console.log('[preflight-pg-application-task-statuses] OK — every persisted state is allowed.')
    return 0
  } finally {
    await db.close()
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  runCli()
    .then((exitCode) => { process.exitCode = exitCode })
    .catch((error) => {
      console.error('[preflight-pg-application-task-statuses] ERROR:', error?.message || error)
      process.exitCode = 1
    })
}
