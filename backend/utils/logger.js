/**
 * Shared structured logger.
 *
 * Purpose:
 *   The repo had ~2,000 ad-hoc console.log / console.warn / console.error
 *   statements spread across crawlers, routes, and services. That made
 *   production logs noisy, hard to grep, and obscured genuine failures.
 *
 * This module provides a small, dependency-free structured logger that:
 *   - Namespaces every log line with a component tag (e.g. `[applyEngine]`)
 *     so operators can grep by subsystem.
 *   - Honors LOG_LEVEL (error | warn | info | debug) with a safe default of
 *     `info` in production and `debug` in non-production.
 *   - Supports structured context objects (stringified in a stable way) so
 *     downstream log collectors can parse them.
 *   - Keeps one-liners: `const log = createLogger('applyEngine')`.
 *
 * This file is intentionally zero-dependency so it can be imported from
 * anywhere in the backend without bringing in pino/winston.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

function resolveThreshold() {
  const raw = String(process.env.LOG_LEVEL || '').trim().toLowerCase()
  if (raw && LEVELS[raw] !== undefined) return LEVELS[raw]
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase()
  return env === 'production' ? LEVELS.info : LEVELS.debug
}

let _threshold = resolveThreshold()

export function setLogLevel(level) {
  const key = String(level || '').toLowerCase()
  if (LEVELS[key] !== undefined) _threshold = LEVELS[key]
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === _threshold) || 'info'
}

// ---------------------------------------------------------------------------
// In-memory ring buffer of recent log records.
//
// Why: adminHealthLogs (admin.anya tool) previously returned a stub message
// saying "Log integration would require connection to logging system".
// We keep a bounded, in-process ring buffer so operators and Anya can read
// recent logs through the admin tool without adding a pino/winston/file
// dependency. Size is intentionally small so memory cannot grow unbounded.
// ---------------------------------------------------------------------------
const MAX_RECORDS = Number(process.env.LOG_BUFFER_SIZE || 500)
const _records = []

function pushRecord(rec) {
  _records.push(rec)
  if (_records.length > MAX_RECORDS) {
    _records.splice(0, _records.length - MAX_RECORDS)
  }
}

export function getRecentLogs({ level, source, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, MAX_RECORDS))
  const wantLevel = level && LEVELS[String(level).toLowerCase()] !== undefined
    ? String(level).toLowerCase()
    : null
  const wantLevelNum = wantLevel ? LEVELS[wantLevel] : null
  const wantSource = source ? String(source).toLowerCase() : null
  const out = []
  for (let i = _records.length - 1; i >= 0 && out.length < cap; i -= 1) {
    const r = _records[i]
    if (wantLevelNum !== null && LEVELS[r.level] > wantLevelNum) continue
    if (wantSource && !String(r.namespace || '').toLowerCase().includes(wantSource)) continue
    out.push(r)
  }
  return out
}

export function clearRecentLogs() {
  _records.length = 0
}

function formatContext(ctx) {
  if (ctx === undefined || ctx === null) return ''
  if (typeof ctx === 'string') return ` ${ctx}`
  if (ctx instanceof Error) {
    return ` ${ctx.message}${ctx.stack ? `\n${ctx.stack}` : ''}`
  }
  try {
    return ` ${JSON.stringify(ctx, (_k, v) => {
      if (v instanceof Error) return { message: v.message, stack: v.stack }
      if (typeof v === 'bigint') return v.toString()
      return v
    })}`
  } catch {
    return ` ${String(ctx)}`
  }
}

/**
 * Create a namespaced logger.
 *
 *   const log = createLogger('applyEngine')
 *   log.info('populate.start', { applicationId })
 *   log.warn('populate.snapshot_parse_failed', err)
 *   log.error('populate.export_failed', { applicationId, format }, err)
 *
 * Call signature: logger.level(event, ...contextObjects)
 * All context objects are concatenated into the emitted log line.
 */
export function createLogger(namespace) {
  const ns = String(namespace || 'app').trim() || 'app'
  const tag = `[${ns}]`

  function emit(level, sink, event, rest) {
    if (LEVELS[level] > _threshold) return
    const message = `${tag} ${String(event || '')}`.trim()
    const ctxString = rest.map(formatContext).join('')
    const line = `${message}${ctxString}`
    pushRecord({
      ts: new Date().toISOString(),
      level,
      namespace: ns,
      event: String(event || ''),
      message: line,
    })
    sink(line)
  }

  return {
    namespace: ns,
    error(event, ...rest) { emit('error', console.error.bind(console), event, rest) },
    warn(event, ...rest)  { emit('warn', console.warn.bind(console), event, rest) },
    info(event, ...rest)  { emit('info', console.log.bind(console), event, rest) },
    debug(event, ...rest) { emit('debug', console.log.bind(console), event, rest) },
    child(sub) {
      const childNs = sub ? `${ns}.${sub}` : ns
      return createLogger(childNs)
    },
  }
}

const rootLogger = createLogger('grantflow')

export default rootLogger
