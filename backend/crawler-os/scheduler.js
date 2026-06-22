// crawler-os/scheduler.js
//
// Background scheduler. Runs ONE full agent cycle at a time (Sam -> Robert ->
// Yana -> John -> Hamilton -> Sam postflight), guarded by a durable lock so
// duplicate runs never overlap, with a heartbeat per step. It honors the Agent
// Control Center: before each agent it checks control.getStatus() and will pause
// (skip remaining) or abort (stop / emergency-stop) durably, mid-cycle.
//
// The clock and "tick" are injectable so the whole thing runs deterministically
// in tests with no real timers. start(intervalMs) wires setInterval for
// production; tests call runCycle() directly.

import { CYCLE_ORDER } from './agents/index.js';
import { acquireLock, releaseLock, heartbeat, recordAgentJob } from './storage.js';

const CYCLE_LOCK = 'agent_cycle';

export function createScheduler(deps = {}) {
  const { store, fleet, control, clock = () => Date.now(), lockTtlMs = 5 * 60_000 } = deps;
  if (!store || !fleet) throw new Error('createScheduler: store and fleet required');

  let timer = null;
  let running = false;

  function controlAllows() {
    if (!control) return 'go'; // no control object means an explicit local/manual run
    const st = control.getStatus();
    if (st === 'running') return 'go';
    if (st === 'paused') return 'pause';
    return 'abort'; // idle/stopped/emergency_stopped do not run agents
  }

  /**
   * runCycle — execute one full cycle. Returns a per-agent report.
   * @param {{ profiles?:object[], hamiltonTasks?:object[], now?:number }} [opts]
   */
  async function runCycle(opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : clock();
    if (!acquireLock(store, CYCLE_LOCK, { ttlMs: lockTtlMs, now })) {
      return { ran: false, reason: 'cycle_already_running' };
    }
    running = true;
    const report = { ran: true, started_at: new Date(now).toISOString(), steps: [], aborted: false, paused: false };
    try {
      // Sam preflight
      if (!step(report, controlAllows())) return finish(report, now);
      report.steps.push({ agent: 'sam', phase: 'preflight', result: await fleet.sam.run({ phase: 'preflight', now }) });
      heartbeat(store, 'scheduler', { now: clock(), status: 'running' });

      for (const id of CYCLE_ORDER) {
        if (id === 'sam') continue; // preflight already ran; postflight runs at end
        const gate = controlAllows();
        if (!step(report, gate)) return finish(report, now);

        if (id === 'robert') {
          report.steps.push({ agent: 'robert', result: await fleet.robert.run({ profiles: opts.profiles ?? [], now }) });
        } else if (id === 'yana') {
          report.steps.push({ agent: 'yana', result: await fleet.yana.run({ candidates: opts.yanaCandidates ?? [], now }) });
        } else if (id === 'john') {
          report.steps.push({ agent: 'john', result: await fleet.john.run({ now }) });
        } else if (id === 'hamilton') {
          // Hamilton processes explicitly authorized, queued tasks only.
          const tasks = opts.hamiltonTasks ?? [];
          const results = [];
          for (const t of tasks) results.push(await fleet.hamilton.complete({ ...t, now }));
          report.steps.push({ agent: 'hamilton', result: { processed: results.length, results } });
        }
        heartbeat(store, 'scheduler', { now: clock(), status: 'running' });
      }

      // Sam postflight
      if (step(report, controlAllows())) {
        report.steps.push({ agent: 'sam', phase: 'postflight', result: await fleet.sam.run({ phase: 'postflight', now: clock() }) });
      }
      return finish(report, now);
    } catch (e) {
      report.error = String(e?.message ?? e);
      recordAgentJob(store, { agent_id: 'scheduler', kind: 'cycle', status: 'error', detail: { error: report.error } });
      return finish(report, now);
    } finally {
      running = false;
    }
  }

  function step(report, gate) {
    if (gate === 'pause') { report.paused = true; return false; }
    if (gate === 'abort') { report.aborted = true; return false; }
    return true;
  }
  function finish(report, now) {
    report.finished_at = new Date(clock()).toISOString();
    releaseLock(store, CYCLE_LOCK);
    heartbeat(store, 'scheduler', { now: clock(), status: 'idle' });
    recordAgentJob(store, { agent_id: 'scheduler', kind: 'cycle', status: report.aborted ? 'aborted' : report.paused ? 'paused' : 'ok', detail: { steps: report.steps.length } });
    return report;
  }

  return {
    runCycle,
    isRunning: () => running,
    /** start a production interval loop (no-op clock in tests; prefer runCycle there). */
    start(intervalMs = 60_000, cycleOpts = {}) {
      if (timer) return;
      timer = setInterval(() => { runCycle(cycleOpts).catch(() => {}); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

export default { createScheduler };
