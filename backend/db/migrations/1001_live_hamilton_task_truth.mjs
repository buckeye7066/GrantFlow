import { getDb } from '../index.js'
import { runStrictPipelineReconciliation } from '../../services/pipelineStrictReconciliation.js'

/**
 * Reconcile every unfinished Hamilton task with current canonical ACCEPT plus
 * the positive REAL / RELATABLE / COVERS-NEED / QUALIFIES contract. Idempotent:
 * invalid work becomes cancelled history and its source is tombstoned.
 *
 * PostgreSQL migration callbacks receive a deliberately narrow transaction
 * facade. The reconciliation composes production services that require the
 * complete database adapter (including their own transactional operations), so
 * use the canonical adapter there. SQLite already supplies the complete adapter
 * as its callback value and keeps the migration atomic.
 *
 * Deliberately let an incomplete reconciliation reject. The migration runner
 * records the ledger entry only after this function resolves; a crash between
 * reconciliation and the stamp simply retries this idempotent repair.
 */
export default async function up(migrationDb) {
  const db = migrationDb?.dialect === 'postgres' ? getDb() : migrationDb
  await runStrictPipelineReconciliation(db, {
    limit: 100000,
    actor: 'migration:1001_live_hamilton_task_truth',
  })
}
