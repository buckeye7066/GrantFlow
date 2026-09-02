import { getDb } from '../../index.js'
import { runStrictPipelineReconciliation } from '../../../services/pipelineStrictReconciliation.js'

/**
 * PostgreSQL twin of the SQLite live Hamilton task-truth reconciliation.
 *
 * The migration runner's callback value is a narrow PostgresTx facade, while
 * the reconciliation intentionally composes production services that require
 * the full pooled adapter and may open their own transactions. Run the
 * idempotent reconciliation through that canonical adapter. The surrounding
 * migration still writes its ledger row only after this function resolves, so
 * an incomplete repair remains pending and a crash before the stamp retries.
 */
export default async function up(migrationDb) {
  const db = migrationDb?.dialect === 'postgres' ? getDb() : migrationDb
  await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:1001_live_hamilton_task_truth',
  })
}
