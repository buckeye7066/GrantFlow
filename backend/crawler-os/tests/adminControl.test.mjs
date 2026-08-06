// tests/adminControl.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createAdminControl, CONTROL_STATE } from '../adminControl.js';

const ADMIN = 'owner@example.invalid';
const NOT_ADMIN = 'someone@else.com';

function createControl() {
  return createAdminControl({ store: createMemoryStore(), admin: ADMIN });
}

test('the control center starts idle and the admin can start it', () => {
  const ctl = createControl();
  assert.equal(ctl.getStatus(), CONTROL_STATE.IDLE);
  ctl.start(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.RUNNING);
});

test('only the single admin may control the process', () => {
  const ctl = createControl();
  assert.throws(() => ctl.start(NOT_ADMIN), /unauthorized/i);
  assert.throws(() => ctl.stop(NOT_ADMIN), /unauthorized/i);
  assert.throws(() => ctl.emergencyStop(NOT_ADMIN), /unauthorized/i);
});

test('pause/resume only work from the correct state', () => {
  const ctl = createControl();
  // cannot pause from idle
  assert.throws(() => ctl.pause(ADMIN), /cannot pause/i);
  ctl.start(ADMIN);
  ctl.pause(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.PAUSED);
  ctl.resume(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.RUNNING);
});

test('emergency stop latches and blocks a restart until explicitly cleared', () => {
  const ctl = createControl();
  ctl.start(ADMIN);
  ctl.emergencyStop(ADMIN, 'kill switch');
  assert.equal(ctl.getStatus(), CONTROL_STATE.EMERGENCY_STOPPED);
  // cannot just start again
  assert.throws(() => ctl.start(ADMIN), /emergency/i);
  // must clear first
  ctl.clearEmergency(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.IDLE);
  ctl.start(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.RUNNING);
});

test('stop is reachable from any state', () => {
  const ctl = createControl();
  ctl.start(ADMIN);
  ctl.stop(ADMIN);
  assert.equal(ctl.getStatus(), CONTROL_STATE.STOPPED);
});

test('every control transition is persisted as an audited admin event', () => {
  const ctl = createControl();
  ctl.start(ADMIN);
  ctl.pause(ADMIN);
  ctl.resume(ADMIN);
  const history = ctl.history();
  assert.ok(history.length >= 3);
  for (const ev of history) {
    assert.equal(ev.actor, ADMIN);
    assert.ok(ev.action);
  }
});

test('clearEmergency only works when actually emergency-stopped', () => {
  const ctl = createControl();
  assert.throws(() => ctl.clearEmergency(ADMIN), /not in emergency/i);
});
