import { runStrictPipelineReconciliation } from '../../../services/pipelineStrictReconciliation.js'

/**
 * PostgreSQL twin of the SQLite live Hamilton task-truth reconciliation.
 * Incomplete reconciliation must reject so the surrounding transaction rolls
 * back and the migration ledger is not falsely advanced.
 */
export default async function up(db) {
  await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:1001_live_hamilton_task_truth',
  })
}
