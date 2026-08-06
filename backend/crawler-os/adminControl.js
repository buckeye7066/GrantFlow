// crawler-os/adminControl.js
//
// Agent Control Center. The explicitly configured admin/operator can
// start, stop, pause, resume, and emergency-stop the whole agent process. Every
// transition is authorized (non-admin actors are rejected) and persisted as an
// admin event. The scheduler reads getStatus() before each agent so pause/stop/
// emergency-stop are durable and honored mid-cycle.
//
// States: idle -> running <-> paused ; any -> stopped ; any -> emergency_stopped.

import { recordAdminEvent, getAdminEvents } from './storage.js';

export const CONTROL_STATE = Object.freeze({
  IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused',
  STOPPED: 'stopped', EMERGENCY_STOPPED: 'emergency_stopped',
});

export function createAdminControl(deps = {}) {
  const store = deps.store;
  if (!store) throw new Error('createAdminControl: store required');
  // The application shell owns privileged-identity configuration. Crawler OS
  // receives only the already-validated operator capability and never reaches
  // across its architecture boundary into deployment config.
  const admin = typeof deps.admin === 'string' && deps.admin.trim()
    ? deps.admin.trim().toLowerCase()
    : null;
  let state = deps.initialState ?? CONTROL_STATE.IDLE;

  function authorize(actor) {
    const normalizedActor = typeof actor === 'string' ? actor.trim().toLowerCase() : '';
    if (!admin || normalizedActor !== admin) {
      const err = new Error('unauthorized: configured operator required for agent control');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
  }
  function transition(actor, action, next, detail = {}) {
    authorize(actor);
    const from = state;
    state = next;
    recordAdminEvent(store, { actor, action, detail: { from, to: next, ...detail } });
    return { ok: true, from, to: next };
  }

  return {
    ADMIN_EMAIL: admin,
    CONTROL_STATE,

    getStatus() { return state; },
    isRunning() { return state === CONTROL_STATE.RUNNING; },
    isPaused() { return state === CONTROL_STATE.PAUSED; },
    isStopped() { return state === CONTROL_STATE.STOPPED || state === CONTROL_STATE.EMERGENCY_STOPPED; },

    start(actor) {
      authorize(actor);
      if (state === CONTROL_STATE.EMERGENCY_STOPPED) {
        // Emergency stop must be explicitly cleared before restart.
        const err = new Error('cannot start: system is emergency-stopped; clear it first'); err.code = 'EMERGENCY_LOCKED'; throw err;
      }
      return transition(actor, 'start', CONTROL_STATE.RUNNING);
    },
    pause(actor) {
      authorize(actor);
      if (state !== CONTROL_STATE.RUNNING) { const e = new Error(`cannot pause from "${state}"`); e.code = 'BAD_TRANSITION'; throw e; }
      return transition(actor, 'pause', CONTROL_STATE.PAUSED);
    },
    resume(actor) {
      authorize(actor);
      if (state !== CONTROL_STATE.PAUSED) { const e = new Error(`cannot resume from "${state}"`); e.code = 'BAD_TRANSITION'; throw e; }
      return transition(actor, 'resume', CONTROL_STATE.RUNNING);
    },
    stop(actor) { return transition(actor, 'stop', CONTROL_STATE.STOPPED); },
    emergencyStop(actor, reason = 'manual emergency stop') {
      return transition(actor, 'emergency_stop', CONTROL_STATE.EMERGENCY_STOPPED, { reason });
    },
    /** Clear an emergency stop back to idle (admin only). */
    clearEmergency(actor) {
      authorize(actor);
      if (state !== CONTROL_STATE.EMERGENCY_STOPPED) { const e = new Error('not in emergency stop'); e.code = 'BAD_TRANSITION'; throw e; }
      return transition(actor, 'clear_emergency', CONTROL_STATE.IDLE);
    },

    history() { return getAdminEvents(store); },
  };
}

export default { createAdminControl, CONTROL_STATE };
