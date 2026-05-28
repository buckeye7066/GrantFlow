import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  GRANT_STATUSES,
  GRANT_STATUS_ALIASES,
} from '../../backend/config/constants.js'

/**
 * Regression tests pinning the pipeline-totals contract.
 *
 * Why this file exists:
 *
 * Users reported "pipeline totals do not match what is in the pipelines".
 * Root cause: three independent lists of grant statuses had drifted apart:
 *
 *   1. backend/config/constants.js  -> GRANT_STATUSES (API validator)
 *   2. backend/db/postgres/migrations/0032_expand_grants_status_check.sql
 *      (Postgres CHECK constraint)
 *   3. src/components/pipeline/KanbanBoard.jsx STATUSES (UI columns)
 *
 * When the API validator rejected a valid UI status, drag-and-drop saves
 * 400'd silently. When the UI lacked a column for a status returned by the
 * API, those grants vanished from the board but were still counted in the
 * header total. Either bug violates the project rule:
 *
 *   "Counts displayed in the UI must map 1:1 to backend response fields."
 *
 * These tests fail loudly if any of the three lists drift again.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

function readKanbanStatuses() {
  const file = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'components', 'pipeline', 'KanbanBoard.jsx'),
    'utf8',
  )
  // Pull the STATUSES literal: { value: "...", label: "...", icon: ... }
  const block = file.match(/const STATUSES = \[([\s\S]*?)\];/)
  assert.ok(block, 'KanbanBoard STATUSES literal must exist')
  const values = [...block[1].matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(values.length > 5, 'KanbanBoard STATUSES must contain entries')
  return values
}

function readDbCheckStatuses() {
  const file = fs.readFileSync(
    path.join(
      REPO_ROOT,
      'backend',
      'db',
      'postgres',
      'migrations',
      '0032_expand_grants_status_check.sql',
    ),
    'utf8',
  )
  const block = file.match(/CHECK \(status IN \(([\s\S]*?)\)\);/)
  assert.ok(block, 'DB CHECK constraint must define status IN (...)')
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('GRANT_STATUSES is a superset of every Kanban column (no API rejection of valid UI status)', () => {
  const kanban = readKanbanStatuses().filter((s) => s !== 'other')
  for (const s of kanban) {
    assert.ok(
      GRANT_STATUSES.includes(s),
      `UI status "${s}" must be a valid GRANT_STATUSES value or the API will 400 on save`,
    )
  }
})

test('GRANT_STATUSES is exactly the union of the DB CHECK constraint statuses', () => {
  const dbStatuses = new Set(readDbCheckStatuses())
  const configStatuses = new Set(GRANT_STATUSES)

  for (const s of configStatuses) {
    assert.ok(
      dbStatuses.has(s),
      `GRANT_STATUSES contains "${s}" but the Postgres CHECK constraint does not — INSERTs will fail`,
    )
  }
  for (const s of dbStatuses) {
    assert.ok(
      configStatuses.has(s),
      `Postgres CHECK constraint allows "${s}" but GRANT_STATUSES rejects it — API will 400 on a valid row`,
    )
  }
})

test('every Kanban status (minus the synthetic "other" bucket) maps to a real DB status', () => {
  const kanban = readKanbanStatuses().filter((s) => s !== 'other')
  const dbStatuses = new Set(readDbCheckStatuses())
  for (const s of kanban) {
    assert.ok(
      dbStatuses.has(s),
      `KanbanBoard exposes column "${s}" but the DB CHECK constraint does not allow it — drag-to-this-column writes will fail`,
    )
  }
})

test('KanbanBoard exposes an "other" catch-all column so totals never silently drop', () => {
  const kanban = readKanbanStatuses()
  assert.ok(
    kanban.includes('other'),
    'KanbanBoard must include a synthetic "other" column so grants with unknown statuses are still visible (and counted)',
  )
})

test('GRANT_STATUS_ALIASES covers every legacy DB status', () => {
  // Every status the DB CHECK still allows but the UI columns no longer
  // expose must have a canonical alias so legacy rows render in the
  // correct column instead of "other".
  const kanbanColumns = new Set(readKanbanStatuses())
  const dbStatuses = readDbCheckStatuses()
  for (const s of dbStatuses) {
    if (kanbanColumns.has(s)) continue
    if (s === 'other') continue
    assert.ok(
      Object.prototype.hasOwnProperty.call(GRANT_STATUS_ALIASES, s),
      `Legacy DB status "${s}" has no Kanban column AND no alias in GRANT_STATUS_ALIASES — grants with this status will land in "other"`,
    )
    const aliased = GRANT_STATUS_ALIASES[s]
    assert.ok(
      kanbanColumns.has(aliased),
      `GRANT_STATUS_ALIASES maps "${s}" -> "${aliased}" but the Kanban has no column for "${aliased}"`,
    )
  }
})
