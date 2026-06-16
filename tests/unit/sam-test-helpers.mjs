/**
 * Tiny in-memory DB shim shared by Sam unit tests. Implements just enough
 * `prepare(...).get/.all/.run` surface to drive samAuditStore + samAgent
 * without a real SQLite.
 */

export function makeMemoryDb() {
  const tables = {
    sam_runs: new Map(),
  }

  function prepare(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim()
    return {
      get: (...args) => exec(text, args, 'get'),
      all: (...args) => exec(text, args, 'all'),
      run: (...args) => exec(text, args, 'run'),
    }
  }

  function exec(sql, params, mode) {
    if (sql.startsWith('INSERT INTO sam_runs')) {
      // Matches the 6-placeholder INSERT in samAuditStore.startRun.
      const [id, mode_, trigger, status, started_at, created_by_user_id] = params
      tables.sam_runs.set(id, {
        id, mode: mode_, trigger, status, started_at,
        completed_at: null, health_score: null, production_ready: null,
        summary_json: '{}', findings_json: '[]', repair_plan_json: '[]', applied_fixes_json: '[]',
        error: null, created_by_user_id,
      })
      return { changes: 1 }
    }
    if (sql.startsWith('UPDATE sam_runs SET status = ?')) {
      const [
        status, completed_at, health_score, production_ready,
        summary_json, findings_json, repair_plan_json, applied_fixes_json,
        error, id,
      ] = params
      const row = tables.sam_runs.get(id)
      if (row) {
        Object.assign(row, {
          status, completed_at, health_score, production_ready,
          summary_json, findings_json, repair_plan_json, applied_fixes_json,
          error,
        })
      }
      return { changes: row ? 1 : 0 }
    }
    if (sql.startsWith('SELECT * FROM sam_runs WHERE id = ?')) {
      return tables.sam_runs.get(params[0])
    }
    if (sql.startsWith('SELECT * FROM sam_runs ORDER BY started_at DESC LIMIT 1')) {
      const rows = Array.from(tables.sam_runs.values()).sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
      return rows[0]
    }
    if (sql.startsWith('SELECT * FROM sam_runs ORDER BY started_at DESC LIMIT ?')) {
      const limit = Number(params[0]) || 25
      return Array.from(tables.sam_runs.values())
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
        .slice(0, limit)
    }
    if (sql.startsWith("SELECT * FROM sam_runs WHERE status = 'completed'")) {
      return Array.from(tables.sam_runs.values())
        .filter((r) => r.status === 'completed')
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))[0]
    }
    if (sql.startsWith("SELECT * FROM sam_runs WHERE status IN ('failed','cancelled')")) {
      return Array.from(tables.sam_runs.values())
        .filter((r) => r.status === 'failed' || r.status === 'cancelled')
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))[0]
    }
    throw new Error(`Sam test shim: unhandled SQL: ${sql}`)
  }

  return { prepare, tables }
}
