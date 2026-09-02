import { runStrictPipelineReconciliation } from '../../services/pipelineStrictReconciliation.js'

/**
 * Reconcile every unfinished Hamilton task with current canonical ACCEPT plus
 * the positive REAL / RELATABLE / COVERS-NEED / QUALIFIES contract. Idempotent:
 * invalid work becomes cancelled history and its source is tombstoned.
 */
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
