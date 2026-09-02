import { runStrictPipelineReconciliation } from '../../services/pipelineStrictReconciliation.js'

/**
 * Retry the resumable four-gate pass after adding fail-closed Hamilton task
 * cancellation. Idempotent: already-reconciled rows are absent and cancelled
 * tasks are terminal.
 */
export default async function up(db) {
  try {
    await runStrictPipelineReconciliation(db, {
      limit: 100000,
      actor: 'migration:1000_fail_closed_hamilton_reconciliation',
    })
  } catch (error) {
    if (!error?.result || typeof error.result.scanned !== 'number') throw error
  }
}
