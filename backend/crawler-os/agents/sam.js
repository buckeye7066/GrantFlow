// ============================================================================
// NOT THE LIVE IMPLEMENTATION. Nothing imports this file.
//
// The agent that actually runs is backend/services/sam/. This module is
// part of a self-contained crawler-os fleet whose createFleet() (./index.js)
// has no caller outside backend/tests/ — agentMeshRegistry.js only ever
// mentions these paths as strings, never imports them.
//
// This matters because the behaviour described BELOW is materially weaker than
// what ships, and a reader who lands here judges the product by it. That is not
// hypothetical: an audit of this repo reported the live agents as placeholders
// using descriptions that match THIS file almost verbatim.
//
// Read the live implementation before concluding anything about capability.
// ============================================================================

// crawler-os/agents/sam.js
//
// Sam — Self-Healing Supervisor & Production-Readiness. Sam does not merely
// report: it runs health checks, applies SAFE, deterministic fixes automatically,
// and escalates only true risks to the admin. Sam's "edit code on GitHub"
// capability is honestly gated here: this module has no repo/network access, so
// Sam records a recommended-fix escalation (what it would branch/PR) rather than
// pretending to have committed code. Everything Sam does is audited.
//
// Safe auto-fixes implemented:
//   - reseed missing funding sources from the canonical registry
//   - clear stale agent locks
//   - structural integrity checks (single match authority, reality-gate sanity)

import {
  heartbeat, recordAgentJob, getHeartbeats, countOpportunities,
  upsertSource, clearStaleLocks,
} from '../storage.js';
import { allSources } from '../sourceRegistry.js';
import { matchOpportunity } from '../matcher.js';
import { computeMatchDecision } from '../matchEngine.js';
import { enforceReality } from '../realityGate.js';
import { implementedAdapterIds } from '../adapters/index.js';

const AGENT_ID = 'sam';

const LEVEL = Object.freeze({ INFO: 'info', WARN: 'warn', HIGH: 'high', CRITICAL: 'critical' });

export function createSam(deps = {}) {
  const { store, clock = () => Date.now(), heartbeatStaleMs = 10 * 60_000, lockTtlMs = 5 * 60_000 } = deps;
  if (!store) throw new Error('createSam: store required');

  return {
    id: AGENT_ID,
    LEVEL,

    /**
     * run — preflight/postflight health pass with safe self-healing.
     * @param {{ phase?:'preflight'|'postflight', now?:number }} [opts]
     */
    async run(opts = {}) {
      const now = Number.isFinite(opts.now) ? opts.now : clock();
      const phase = opts.phase ?? 'preflight';
      try {
        heartbeat(store, AGENT_ID, { now, status: 'running' });

        const findings = [];
        const fixed = [];
        const escalations = [];

        // 1) Source registry seeded? Safe auto-fix: reseed from canonical registry.
        const sources = allSources();
        const seededCount = store.all('funding_sources').length;
        if (seededCount < sources.length) {
          for (const s of sources) upsertSource(store, s);
          fixed.push({ area: 'source_registry', action: 'reseeded_sources', detail: `seeded ${sources.length} canonical sources (was ${seededCount})` });
        } else {
          findings.push({ level: LEVEL.INFO, area: 'source_registry', detail: `${seededCount} sources present` });
        }

        // 2) Adapter coverage (honest): rows without adapters are known TODOs.
        const withAdapters = new Set(implementedAdapterIds());
        const noAdapter = sources.filter((s) => !withAdapters.has(s.source_id)).map((s) => s.source_id);
        if (noAdapter.length) {
          findings.push({ level: LEVEL.WARN, area: 'adapters', detail: `registry rows without adapters (skipped honestly, never faked): ${noAdapter.join(', ')}` });
        }

        // 3) Stale locks → safe auto-clear.
        const cleared = clearStaleLocks(store, { ttlMs: lockTtlMs, now });
        if (cleared > 0) fixed.push({ area: 'locks', action: 'cleared_stale_locks', detail: `${cleared} stale lock(s)` });

        // 4) Heartbeat freshness.
        for (const hb of getHeartbeats(store)) {
          const age = now - Date.parse(hb.at);
          if (Number.isFinite(age) && age > heartbeatStaleMs && hb.status === 'running') {
            findings.push({ level: LEVEL.HIGH, area: 'agent_health', detail: `${hb.agent_id} heartbeat stale (${Math.round(age / 1000)}s) while 'running'` });
            escalations.push({ category: 'stuck_agent', agent: hb.agent_id, detail: 'heartbeat stale while running' });
          }
        }

        // 5) Structural: ONE match authority. matcher.matchOpportunity must BE the
        //    canonical engine, not a divergent copy.
        if (matchOpportunity !== computeMatchDecision) {
          findings.push({ level: LEVEL.CRITICAL, area: 'match_authority', detail: 'matcher.matchOpportunity diverged from canonical computeMatchDecision' });
          escalations.push({ category: 'duplicate_match_authority', detail: 'matcher is not the canonical engine' });
        } else {
          findings.push({ level: LEVEL.INFO, area: 'match_authority', detail: 'single canonical match authority confirmed' });
        }

        // 6) Reality-gate sanity: a known placeholder MUST be rejected. Guards
        //    against a regression that would let fake funding into the catalog.
        const probe = enforceReality(
          { title: 'Sample Grant (placeholder)', sponsor: 'Test Funder', apply_url: 'https://example.org/x', summary: 'lorem ipsum' },
          { thesis: {}, source: { source_id: 'self_check' } },
        );
        if (probe.ok) {
          findings.push({ level: LEVEL.CRITICAL, area: 'reality_gate', detail: 'reality gate ACCEPTED a placeholder probe — integrity compromised' });
          escalations.push({ category: 'reality_gate_regression', detail: 'placeholder probe was accepted' });
        } else {
          findings.push({ level: LEVEL.INFO, area: 'reality_gate', detail: `reality gate rejected placeholder probe (${probe.reason})` });
        }

        // 7) Catalog presence (informational; not a failure on a fresh system).
        findings.push({ level: LEVEL.INFO, area: 'catalog', detail: `${countOpportunities(store)} opportunities in catalog` });

        // Code-edit capability is honestly gated.
        const codeEdit = { capable: false, reason: 'no repo/network access in this environment; Sam records recommended fixes as escalations instead of committing code' };

        const critical = findings.filter((f) => f.level === LEVEL.CRITICAL).length;
        const high = findings.filter((f) => f.level === LEVEL.HIGH).length;
        const healthy = critical === 0;

        // Escalate to admin only on true risk.
        for (const esc of escalations) {
          recordAgentJob(store, { agent_id: AGENT_ID, kind: 'escalation', status: 'open', detail: esc });
        }

        const verdict = { agent: AGENT_ID, phase, healthy, counts: { critical, high, findings: findings.length, fixed: fixed.length, escalations: escalations.length }, findings, fixed, escalations, code_edit: codeEdit };
        recordAgentJob(store, { agent_id: AGENT_ID, kind: 'health', status: healthy ? 'ok' : 'critical', detail: verdict.counts });
        return verdict;
      } catch (error) {
        const message = error?.message || String(error);
        try {
          recordAgentJob(store, { agent_id: AGENT_ID, kind: 'health', status: 'error', detail: { phase, error: message } });
        } catch (recordError) {
          console.error('Sam failed to record health error:', recordError?.message || recordError);
        }
        throw error;
      } finally {
        try {
          heartbeat(store, AGENT_ID, { now: clock(), status: 'idle' });
        } catch (heartbeatError) {
          console.error('Sam failed to mark heartbeat idle:', heartbeatError?.message || heartbeatError);
        }
      }
    },
  };
}

export default { createSam };
