import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { GRANT_STATUSES } from '../../backend/config/constants.js'
import { canonicalStage, PIPELINE_STAGES } from '../../shared/pipelineStages.js'

function read(relPath) {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
}

// Drift guard for the RC-13 canonical pipeline contract: every status the
// backend can store/return (GRANT_STATUSES) must be routable to a Kanban
// column. With RC-13 routing happens via shared/pipelineStages.canonicalStage
// (a stage either IS a canonical 11-stage value, or maps to one via the
// PIPELINE_STAGE_ALIASES map). Anything that doesn't resolve would silently
// vanish from the board — a "counts must map 1:1" violation.
test('every GRANT_STATUS resolves to a canonical Kanban column', () => {
  const unrouted = GRANT_STATUSES.filter((status) => canonicalStage(status) === null)
  assert.deepEqual(
    unrouted,
    [],
    `These statuses have no canonical column and would be dropped from the pipeline: ${unrouted.join(', ')}`,
  )
})

test('deadline_passed is a known status (constants + canonical resolver)', () => {
  assert.ok(GRANT_STATUSES.includes('deadline_passed'), 'GRANT_STATUSES must include deadline_passed')
  assert.equal(
    canonicalStage('deadline_passed'),
    'archived',
    'deadline_passed must resolve to a canonical column',
  )
})

test('every canonical stage actually appears as a Kanban column literal', () => {
  // Belt-and-suspenders: confirm the 11 canonical stages each have a column
  // in KanbanBoard.jsx so the aliases above have somewhere to bucket into.
  const kanban = read('src/components/pipeline/KanbanBoard.jsx')
  const missing = PIPELINE_STAGES.filter((stage) => !kanban.includes(`"${stage}"`) && !kanban.includes(`'${stage}'`))
  assert.deepEqual(
    missing,
    [],
    `Canonical stages missing a Kanban column literal: ${missing.join(', ')}`,
  )
})
