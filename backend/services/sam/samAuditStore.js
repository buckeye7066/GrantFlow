/**
 * samAuditStore.js
 *
 * Persistence + querying for `sam_runs`. Also owns the `maskSecrets`
 * helper Sam uses everywhere it has to log a string (stdout/stderr from
 * a child process, environment dumps, repair patches, ...).
 *
 * Sam writes a row PER ORCHESTRATING RUN. Per-tool history continues to
 * live in `anya_runs` / `audit_logs` (Sam delegates to those tools and
 * those services already log themselves).
 */

import { SAM_RUN_STATUS, SAM_TRIGGERS } from './samTypes.js'

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------
//
// Sam captures stdout/stderr from production gates; some commands echo
// environment variables or accidentally include API keys when they fail.
// We always pass output through `maskSecrets` BEFORE persisting or
// returning to the admin client.

const MASK = '***REDACTED***'

// Each entry pairs a regex with the REPLACEMENT function so we can preserve
// the original separator. Pattern 1 owns env-var-style assignments (var=val,
// "var": "val") and writes back `var=***REDACTED***`. Pattern 2 owns the
// HTTP `Authorization: Bearer …` shape and preserves the original prefix
// verbatim. The remaining patterns redact bare tokens entirely.
const SECRET_PATTERNS = [
  {
    re: /(\b(?:PASSWORD|TOKEN|SECRET|API[_-]?KEY|PRIVATE[_-]?KEY|ANTHROPIC[_-]?API[_-]?KEY|OPENAI[_-]?API[_-]?KEY|JWT[_-]?SECRET|ADMIN[_-]?TOKEN|ANYA[_-]?ADMIN[_-]?TOKEN|DATABASE[_-]?URL|SUPABASE[_-]?[A-Z_]+|SUPABASE_KEY|STRIPE[_-]?[A-Z_]+|SMTP[_-]?[A-Z_]+|SENDGRID[_-]?[A-Z_]+)[\w-]*)\s*[:=]\s*["']?([^\s"']+)/gi,
    replace: (_m, name) => `${name}=${MASK}`,
  },
  {
    re: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi,
    replace: (_m, prefix) => `${prefix}${MASK}`,
  },
  {
    re: /\b((?:sk|pk|gfsk|ghp|gho|ghs|sk-ant|key)[-_][A-Za-z0-9_-]{16,})\b/g,
    replace: () => MASK,
  },
  {
    re: /(["'])([A-Za-z0-9+/=]{40,})\1/g,
    replace: (_m, quote) => `${quote}${MASK}${quote}`,
  },
]

export function maskSecrets(input) {
  if (input === null || input === undefined) return input
  if (typeof input === 'object') {
    try {
      return JSON.parse(maskSecrets(JSON.stringify(input)))
    } catch {
      return input
    }
  }
  let value = String(input)
  for (const { re, replace } of SECRET_PATTERNS) {
    re.lastIndex = 0
    value = value.replace(re, replace)
  }
  // Hard cap log length so a runaway dump can never exhaust memory.
  if (value.length > 100_000) {
    value = `${value.slice(0, 100_000)}\n…[truncated by Sam at 100k chars]…`
  }
  return value
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
function safeStringify(value) {
  try { return JSON.stringify(value ?? null) } catch { return 'null' }
}

function safeParse(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

function nowISO() { return new Date().toISOString() }

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
export async function startRun(db, {
  mode,
  trigger = SAM_TRIGGERS.MANUAL,
  created_by_user_id = null,
} = {}) {
  if (!db?.prepare) throw new Error('startRun: db is required')
  if (!mode) throw new Error('startRun: mode is required')

  const id = `sam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await db
    .prepare(`INSERT INTO sam_runs (id, mode, trigger, status, started_at, summary_json,
                                    findings_json, repair_plan_json, applied_fixes_json,
                                    created_by_user_id)
              VALUES (?, ?, ?, ?, ?, '{}', '[]', '[]', '[]', ?)`)
    .run(id, mode, trigger, SAM_RUN_STATUS.RUNNING, nowISO(), created_by_user_id ?? null)
  return id
}

export async function completeRun(db, runId, {
  status = SAM_RUN_STATUS.COMPLETED,
  health_score = null,
  production_ready = null,
  summary = {},
  findings = [],
  repair_plan = [],
  applied_fixes = [],
  error = null,
} = {}) {
  if (!db?.prepare) throw new Error('completeRun: db is required')
  if (!runId) throw new Error('completeRun: runId is required')

  await db
    .prepare(`UPDATE sam_runs
                SET status = ?,
                    completed_at = ?,
                    health_score = ?,
                    production_ready = ?,
                    summary_json = ?,
                    findings_json = ?,
                    repair_plan_json = ?,
                    applied_fixes_json = ?,
                    error = ?
              WHERE id = ?`)
    .run(
      status,
      nowISO(),
      health_score ?? null,
      production_ready === true ? 1 : production_ready === false ? 0 : null,
      safeStringify(maskSecrets(summary)),
      safeStringify(maskSecrets(findings)),
      safeStringify(maskSecrets(repair_plan)),
      safeStringify(maskSecrets(applied_fixes)),
      error ? String(maskSecrets(error)).slice(0, 4_000) : null,
      runId,
    )

  // Persist individual findings into sam_findings so Mission Control's Sam
  // findings card + severity metrics reflect real audit output. Best-effort:
  // the table is created by migration 0096/100 + boot self-heal, but older DBs
  // may lack it.
  try {
    const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    for (const f of Array.isArray(findings) ? findings : []) {
      if (!f) continue
      await db
        .prepare(`INSERT INTO sam_findings
                    (sam_run_id, severity, status, event_type, title, description, file_path, details_json, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn})`)
        .run(
          runId,
          f.severity || 'info',
          f.status || 'open',
          f.event_type || f.type || null,
          f.title || f.message || f.id || 'finding',
          f.description || f.detail || null,
          f.file_path || f.file || null,
          // The table has no dedicated recommended_fix/evidence columns, so we
          // bundle the rest of the finding here — this is what makes a
          // persisted finding actionable later (the admin panel's "what's
          // the fix" / "re-check" affordances read it back via details_json).
          safeStringify(maskSecrets({
            ...(f.details || f.data || {}),
            recommended_fix: f.recommended_fix || null,
            evidence: f.evidence || null,
            category: f.category || null,
            confidence: typeof f.confidence === 'number' ? f.confidence : null,
            safe_auto_fix_available: Boolean(f.safe_auto_fix_available),
          })),
        )
    }
  } catch { /* sam_findings missing on older DBs — non-fatal */ }
}

export async function getRun(db, runId) {
  if (!db?.prepare) throw new Error('getRun: db is required')
  if (!runId) return null
  const row = await db.prepare('SELECT * FROM sam_runs WHERE id = ? LIMIT 1').get(runId)
  if (!row) return null
  return shapeRow(row)
}

export async function listRuns(db, { limit = 25 } = {}) {
  if (!db?.prepare) throw new Error('listRuns: db is required')
  const cap = Math.max(1, Math.min(100, Number(limit) || 25))
  const rows = await db
    .prepare('SELECT * FROM sam_runs ORDER BY started_at DESC LIMIT ?')
    .all(cap)
  return rows.map(shapeRow)
}

export async function latestRun(db) {
  if (!db?.prepare) throw new Error('latestRun: db is required')
  const row = await db
    .prepare('SELECT * FROM sam_runs ORDER BY started_at DESC LIMIT 1')
    .get()
  return row ? shapeRow(row) : null
}

export async function latestSuccessfulRun(db) {
  if (!db?.prepare) throw new Error('latestSuccessfulRun: db is required')
  const row = await db
    .prepare(
      `SELECT * FROM sam_runs
        WHERE status = 'completed'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get()
  return row ? shapeRow(row) : null
}

export async function latestFailedRun(db) {
  if (!db?.prepare) throw new Error('latestFailedRun: db is required')
  const row = await db
    .prepare(
      `SELECT * FROM sam_runs
        WHERE status IN ('failed','cancelled')
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get()
  return row ? shapeRow(row) : null
}

// ---------------------------------------------------------------------------
// Internal: reshape a raw DB row
// ---------------------------------------------------------------------------
function shapeRow(row) {
  if (!row) return null
  return {
    id: row.id,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    health_score: row.health_score === null || row.health_score === undefined
      ? null : Number(row.health_score),
    production_ready: row.production_ready === 1 || row.production_ready === true
      ? true : row.production_ready === 0 || row.production_ready === false
        ? false : null,
    summary: safeParse(row.summary_json, {}),
    findings: safeParse(row.findings_json, []),
    repair_plan: safeParse(row.repair_plan_json, []),
    applied_fixes: safeParse(row.applied_fixes_json, []),
    error: row.error || null,
    created_by_user_id: row.created_by_user_id || null,
  }
}

const FINDING_STATUSES = Object.freeze(['open', 'resolved', 'ignored'])

/**
 * Update a single persisted finding's triage status ("What good is a
 * reported error, if there is no way to fix it" — the owner-facing Sam
 * findings panel needs a real per-row action, not just a read-only badge).
 * Returns the updated row, or null if the finding doesn't exist.
 */
export async function updateFindingStatus(db, findingId, status) {
  if (!db?.prepare) throw new Error('updateFindingStatus: db is required')
  if (!findingId) throw new Error('updateFindingStatus: findingId is required')
  if (!FINDING_STATUSES.includes(status)) {
    throw new Error(`updateFindingStatus: status must be one of ${FINDING_STATUSES.join(', ')}`)
  }
  await db.prepare('UPDATE sam_findings SET status = ? WHERE id = ?').run(status, String(findingId))
  const row = await db.prepare('SELECT * FROM sam_findings WHERE id = ?').get(String(findingId))
  return row || null
}

// Re-export for tests + diagnostics callers.
export const __testing__ = { SECRET_PATTERNS, MASK }
