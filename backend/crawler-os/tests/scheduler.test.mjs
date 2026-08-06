// tests/scheduler.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createScheduler } from '../scheduler.js';
import { createFleet, CYCLE_ORDER } from '../agents/index.js';
import { createAdminControl } from '../adminControl.js';
import { storage } from '../index.js';
import { makeOfflineFetcher, SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';

const TEST_ADMIN = 'owner@example.invalid';

function build() {
  const store = createMemoryStore();
  const fetcher = makeOfflineFetcher();
  const fleet = createFleet({ store, fetcher, env: {} });
  return { store, fetcher, fleet };
}

test('the canonical cycle order is Sam → Robert → Yana → John → Hamilton', () => {
  assert.deepEqual(CYCLE_ORDER, ['sam', 'robert', 'yana', 'john', 'hamilton']);
});

test('a full cycle runs every agent and ends with a Sam postflight', async () => {
  const { store, fleet } = build();
  const scheduler = createScheduler({ store, fleet });
  const report = await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 1_000_000 });
  assert.equal(report.ran, true);
  const agentsInOrder = report.steps.map((s) => s.agent);
  // Sam appears first (preflight) and last (postflight)
  assert.equal(agentsInOrder[0], 'sam');
  assert.equal(agentsInOrder[agentsInOrder.length - 1], 'sam');
  // robert, yana, john, hamilton all ran between
  for (const a of ['robert', 'yana', 'john', 'hamilton']) {
    assert.ok(agentsInOrder.includes(a), `${a} ran in the cycle`);
  }
});

test('the durable lock prevents an overlapping cycle from running', async () => {
  const { store, fleet } = build();
  const scheduler = createScheduler({ store, fleet });
  // pre-acquire the cycle lock to simulate an in-flight run
  assert.equal(storage.acquireLock(store, 'agent_cycle', { now: 2_000_000 }), true);
  const report = await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 2_000_010 });
  assert.equal(report.ran, false);
  assert.equal(report.reason, 'cycle_already_running');
});

test('a paused control center halts the cycle before agents run', async () => {
  const { store, fleet } = build();
  const control = createAdminControl({ store, admin: TEST_ADMIN });
  control.start(TEST_ADMIN);
  control.pause(TEST_ADMIN);
  const scheduler = createScheduler({ store, fleet, control });
  const report = await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 3_000_000 });
  assert.equal(report.paused, true);
  assert.equal(report.steps.length, 0);
});

test('an emergency-stopped control center aborts the cycle', async () => {
  const { store, fleet } = build();
  const control = createAdminControl({ store, admin: TEST_ADMIN });
  control.emergencyStop(TEST_ADMIN, 'test');
  const scheduler = createScheduler({ store, fleet, control });
  const report = await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 4_000_000 });
  assert.equal(report.aborted, true);
});

test('the lock is released after a cycle so the next cycle can run', async () => {
  const { store, fleet } = build();
  const scheduler = createScheduler({ store, fleet });
  await scheduler.runCycle({ profiles: [SAMPLE_VFD_PROFILE], now: 5_000_000 });
  // lock should be free now (fresh acquire succeeds)
  assert.equal(storage.acquireLock(store, 'agent_cycle', { now: 5_000_100 }), true);
});
