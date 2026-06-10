import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GRANT_STATUSES } from '../../backend/config/constants.js'

function read(relPath) {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
}

// Drift guard for the R1 fix: every status the backend can store/return
// (GRANT_STATUSES) must be routable to a column in the pipeline UI — either it
// IS a KanbanBoard column value, or it is mapped to one via STATUS_ALIASES.
// Otherwise a grant in that status silently vanishes from the board (a
// "counts must map 1:1" violation) and PATCH /grants/:id/status would 400 it.
test('every GRANT_STATUS is routable in KanbanBoard (column or alias)', () => {
  const kanban = read('src/components/pipeline/KanbanBoard.jsx')

  // A status is routable if its literal appears in KanbanBoard.jsx at all —
  // it is registered either as a STATUSES column value or as a STATUS_ALIASES key.
  const unrouted = GRANT_STATUSES.filter((status) => !kanban.includes(`"${status}"`) && !kanban.includes(`'${status}'`) && !kanban.includes(`${status}:`))

  assert.deepEqual(
    unrouted,
    [],
    `These statuses have no KanbanBoard column or alias and would be dropped from the pipeline: ${unrouted.join(', ')}`,
  )
})

test('deadline_passed is a known status (constants + Kanban)', () => {
  assert.ok(GRANT_STATUSES.includes('deadline_passed'), 'GRANT_STATUSES must include deadline_passed')
  const kanban = read('src/components/pipeline/KanbanBoard.jsx')
  assert.ok(kanban.includes('deadline_passed'), 'KanbanBoard must route deadline_passed')
})
