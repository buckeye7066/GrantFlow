// EVA agent telemetry — thin wrapper over the unified agent_activity_events
// sink so EVA appears in Mission Control alongside sam/anya/amy. Best-effort:
// never throws, so a telemetry hiccup can never fail an ingest.
//
// 'eva' is registered in agentTelemetryTypes.AGENT_NAMES; without that
// insertActivityEvent() silently no-ops (returns null), so the totality is
// asserted in the eva tests.
import { createLogger } from '../../utils/logger.js'
import { redactText } from './evaTypes.js'

const log = createLogger('service:eva:telemetry')

/**
 * Record one EVA telemetry event. Every free-text field is redacted first so
 * a runner secret / private path can never reach the dashboard. Returns the
 * inserted id or null (never throws).
 */
export async function recordEvaEvent(db, event = {}, { insert } = {}) {
  try {
    const insertFn = insert || (await import('../agentTelemetry/agentTelemetryStore.js')).insertActivityEvent
    return await insertFn(db, {
      agent_name: 'eva',
      event_type: event.event_type || 'eva.event',
      status: event.status || 'info',
      severity: event.severity || 'info',
      title: redactText(event.title || ''),
      description: redactText(event.description || ''),
      metric_key: event.metric_key || null,
      metric_value: event.metric_value ?? null,
      entity_type: event.entity_type || null,
      entity_id: event.entity_id || null,
      details_json: event.details ? JSON.stringify(event.details) : null,
    })
  } catch (err) {
    log.warn('eva telemetry insert failed (non-fatal)', { error: err?.message })
    return null
  }
}
