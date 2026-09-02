import {
  auditUnfinishedHamiltonTasks,
  runStrictPipelineReconciliation,
} from '../../../services/pipelineStrictReconciliation.js'

const INCIDENT_PROFILE_ID = 'c4a92724-9cee-416f-ba30-e91b9b5cd885'

/** PostgreSQL twin of the SQLite live Hamilton task-truth reconciliation. */
export default async function up(db) {
  const priority = await auditUnfinishedHamiltonTasks(db, {
    enforce: true,
    limit: 100000,
    profileId: INCIDENT_PROFILE_ID,
    actor: 'migration:1001_live_hamilton_task_truth:priority_profile',
  })
  if (priority.failed > 0 || priority.repairFailed > 0 || priority.truncated) {
    throw new Error(
      `priority Hamilton reconciliation incomplete: failed=${priority.failed}, repair_failed=${priority.repairFailed}, truncated=${priority.truncated}`,
    )
  }
  try {
    await runStrictPipelineReconciliation(db, {
      limit: 100000,
      actor: 'migration:1001_live_hamilton_task_truth',
    })
  } catch (error) {
    if (!error?.result || typeof error.result.scanned !== 'number') throw error
  }
}
