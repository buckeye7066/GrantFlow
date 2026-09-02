import { runStrictPipelineReconciliation } from '../../../services/pipelineStrictReconciliation.js'

/**
 * One-time PostgreSQL production reconciliation for the four positive pipeline gates.
 */
export default async function up(db) {
  const result = await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:999_strict_pipeline_task_reconciliation',
  })
  if (result.failed > 0 || result.truncated) {
    const error = new Error(`strict pipeline reconciliation failed: failed=${result.failed}, truncated=${result.truncated}`)
    error.result = result
    throw error
  }
}
