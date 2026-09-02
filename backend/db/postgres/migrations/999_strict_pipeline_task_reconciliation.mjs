import { runStrictPipelineReconciliation } from '../../../services/pipelineStrictReconciliation.js'

/**
 * One-time PostgreSQL production reconciliation for the four positive pipeline gates.
 */
export default async function up(db) {
  try {
    await runStrictPipelineReconciliation(db, {
      limit: 100000,
      actor: 'migration:999_strict_pipeline_task_reconciliation',
    })
  } catch (error) {
    // Row-level legacy defects are already recorded in pipeline_precision_last_run.
    // Do not make the entire API unavailable after the bounded pass has safely
    // reconciled every row it could. The ordinary boot invariant retries the
    // residual set on later deploys. Structural failures without an accounting
    // result still abort the migration.
    if (!error?.result || typeof error.result.scanned !== 'number') throw error
  }
}
