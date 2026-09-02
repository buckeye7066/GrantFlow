import { runStrictPipelineReconciliation } from '../../services/pipelineStrictReconciliation.js'

/**
 * Reconcile every unfinished Hamilton task with current canonical ACCEPT plus
 * the positive REAL / RELATABLE / COVERS-NEED / QUALIFIES contract. Idempotent:
 * invalid work becomes cancelled history and its source is tombstoned.
 *
 * Deliberately let an incomplete reconciliation reject. The migration runner
 * records the ledger entry only after this function resolves, so swallowing a
 * controlled reconciliation error would permanently mark dirty data repaired.
 */
export default async function up(db) {
  await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:1001_live_hamilton_task_truth',
  })
}
