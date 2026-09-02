import { runStrictPipelineReconciliation } from '../../services/pipelineStrictReconciliation.js'

/**
 * One-time production reconciliation for the four positive pipeline gates.
 *
 * This deliberately mutates live data. It cancels active Hamilton work and
 * removes early automated grants that cannot positively prove REAL, RELATABLE,
 * COVERS-A-DECLARED-NEED, and QUALIFIES. Submitted/awarded history is retained,
 * marked rejected/ineligible, and removed from future automation truth.
 */
export default async function up(db) {
  const result = await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:999_strict_pipeline_task_reconciliation',
  })

  if (result.failed > 0 || result.truncated) {
    const error = new Error(
      `strict pipeline reconciliation failed: failed=${result.failed}, truncated=${result.truncated}`,
    )
    error.result = result
    throw error
  }
}
