/**
 * agentMeshRegistry.js — the single source of truth for WHO the agents are.
 *
 * AWARENESS (owner directive 2026-07-28): every resident agent must be able to
 * know every other agent — its human name, charter, entry points, and where
 * its telemetry/lessons live — from ONE registry, instead of each subsystem
 * holding its own partial roster (agentControlTypes.ALL_AGENTS, the adapter
 * registry, Amy's scheduler). Those rosters stay the
 * operational authorities for what they gate (start/stop validation, adapter
 * lookup, crawl personas); THIS registry is the mesh's identity choke point:
 * the message store and the lesson store refuse any agent id that is not
 * registered here, so a new agent cannot join the conversation anonymously.
 *
 * REGISTRY + TOTALITY rule (CLAUDE.md): the agent set lives in more than one
 * place, so backend/tests/agentMesh.test.js asserts TOTALITY — every id in
 * ALL_AGENTS / STATUS_AGENTS, every adapter key, and every crawler-os agent
 * module must be registered here, and 'amy' (who lives outside all three)
 * must be too. Adding an agent anywhere without registering it here reds CI.
 *
 * Pure data — no I/O, no env reads. Safe to import from anywhere.
 */

export const AGENT_MESH_REGISTRY = Object.freeze({
  amy: Object.freeze({
    id: 'amy',
    name: 'Amy',
    role: 'Synthetic crawler-training / coverage-gap flywheel',
    charter: 'Close coverage gaps and win the Google-bar: nightly synthetic cohorts derived from the fleet gap scoreboard, bounded KEEP/REVERT tuning, archetype query-steering lessons.',
    capabilities: Object.freeze(['synthetic_cohorts', 'crawler_tuning', 'archetype_learning', 'gap_scoreboard']),
    entry_points: Object.freeze(['backend/services/amy/amyAgent.js runAmyTraining()']),
    telemetry: 'agent_activity_events (agent_name=amy) + amy report store',
    learning_stores: Object.freeze(['system_kv amy_archetype_learning', 'system_kv amy_archetype_metrics', 'system_kv coverage_gap_scoreboard']),
    control: 'scheduler (amyScheduler); not in the agent-control full cycle',
  }),
  sam: Object.freeze({
    id: 'sam',
    name: 'Sam',
    role: 'Production readiness / audit — keeper of the ratchets',
    charter: 'Diagnose, gate, and (admin-authorised only) safe-fix; nightly sweep asserts golden outcomes, gap-scoreboard freshness, and web-parity non-regression.',
    capabilities: Object.freeze(['diagnostics', 'production_gates', 'safe_fixes', 'ratchets']),
    entry_points: Object.freeze(['backend/services/sam/samAgent.js runSam()']),
    telemetry: 'sam_runs + agent_activity_events (agent_name=sam)',
    learning_stores: Object.freeze(['sam_runs findings history', 'system_kv golden_outcome_expectations']),
    control: 'agent-control adapter (samAgentAdapter) + samScheduler',
  }),
  anya: Object.freeze({
    id: 'anya',
    name: 'Anya',
    role: 'Interactive assistant + the owner’s daily report',
    charter: 'Onboarding interviews, root-cause handoffs from Amy, and the 09:00 ET owner digest of everything the fleet did overnight.',
    capabilities: Object.freeze(['owner_reporting', 'onboarding_interview', 'root_cause_handoff']),
    entry_points: Object.freeze(['backend/services/anya/anyaDailyOwnerReport.js runAnyaDailyOwnerReport()']),
    telemetry: 'agent_activity_events (agent_name=anya)',
    learning_stores: Object.freeze(['system_kv sam_daily_code_sweep_run_id pointer']),
    control: 'status-only in the control center (STATUS_AGENTS); interactive/on-demand',
  }),
  robert: Object.freeze({
    id: 'robert',
    name: 'Robert',
    role: 'Funding discovery',
    charter: 'Ingest/discover funding opportunities into the catalog through the canonical gate stack.',
    capabilities: Object.freeze(['opportunity_ingest', 'source_discovery']),
    entry_points: Object.freeze(['backend/services/agentControl/agentAdapters/robertAgentAdapter.js']),
    telemetry: 'robert_runs + agent_activity_events (agent_name=robert)',
    learning_stores: Object.freeze(['robertSourceDiscovery store (env-gated OFF; feeds neither the registry nor the gap queue)']),
    control: 'agent-control adapter (full-cycle order #2)',
  }),
  yana: Object.freeze({
    id: 'yana',
    name: 'Yana',
    role: 'Client discovery (lead intelligence) — NOT Hamilton',
    charter: 'Qualify prospective-client leads and push plausibility-gated contacts to John.',
    capabilities: Object.freeze(['lead_qualification', 'contact_enrichment']),
    entry_points: Object.freeze(['backend/services/agentControl/agentAdapters/yanaAgentAdapter.js']),
    telemetry: 'agent_activity_events (agent_name=yana)',
    learning_stores: Object.freeze(['lead store (needs_enrichment lifecycle)']),
    control: 'agent-control adapter (full-cycle order #3)',
  }),
  john: Object.freeze({
    id: 'john',
    name: 'John',
    role: 'Outreach drafts (Outlook)',
    charter: 'Draft (never send) outreach email for Yana’s plausibility-gated leads.',
    capabilities: Object.freeze(['outreach_drafting']),
    entry_points: Object.freeze(['backend/services/agentControl/agentAdapters/johnAgentAdapter.js']),
    telemetry: 'john_email_drafts + agent_activity_events (agent_name=john)',
    learning_stores: Object.freeze(['john_email_drafts archive (plausibility purges)']),
    control: 'agent-control adapter (full-cycle order #4)',
  }),
  hamilton: Object.freeze({
    id: 'hamilton',
    name: 'Hamilton',
    role: 'Application autopilot / funding completion',
    charter: 'Advance application tasks (classify portals, file missing-info asks, submit only with human-grade evidence).',
    capabilities: Object.freeze(['application_tasks', 'portal_classification']),
    entry_points: Object.freeze(['backend/services/agentControl/agentAdapters/hamiltonAgentAdapter.js']),
    telemetry: 'application_tasks + agent_activity_events (agent_name=hamilton)',
    learning_stores: Object.freeze(['application_missing_info lifecycle']),
    control: 'agent-control adapter (full-cycle order #5)',
  }),
})

export const AGENT_MESH_IDS = Object.freeze(Object.keys(AGENT_MESH_REGISTRY))

/** 'broadcast' is the reserved to-address meaning "every other agent". */
export const MESH_BROADCAST = 'broadcast'

export function getMeshAgent(id) {
  return AGENT_MESH_REGISTRY[String(id || '').toLowerCase()] || null
}

export function isMeshAgent(id) {
  return Boolean(getMeshAgent(id))
}

/**
 * The identity choke point for the message + lesson stores: any write naming
 * an unregistered agent is refused loudly (never silently dropped), so the
 * totality test above is backed by a runtime gate.
 */
export function assertMeshAgent(id, field = 'agent') {
  const key = String(id || '').toLowerCase()
  if (!AGENT_MESH_REGISTRY[key]) {
    throw new Error(`agentMesh: unregistered ${field} "${id}" — register it in agentMeshRegistry.js first`)
  }
  return key
}
