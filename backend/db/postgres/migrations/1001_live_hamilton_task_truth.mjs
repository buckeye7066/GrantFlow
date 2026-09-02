import { runStrictPipelineReconciliation } from '../../../services/pipelineStrictReconciliation.js'

/** PostgreSQL twin of the SQLite live Hamilton task-truth reconciliation. */
export default async function up(db) {
  try {
    await runStrictPipelineReconciliation(db, {
      limit: 100000,
      actor: 'migration:1001_live_hamilton_task_truth',
    })
  } catch (error) {
    if (!error?.result || typeof error.result.scanned !== 'number') throw error
  }
}
