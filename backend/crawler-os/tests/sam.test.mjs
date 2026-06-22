// tests/sam.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createSam } from '../agents/sam.js';
import { storage } from '../index.js';
import { allSources } from '../sourceRegistry.js';

test('Sam reseeds the canonical source registry when sources are missing', async () => {
  const store = createMemoryStore();
  assert.equal(store.all('funding_sources').length, 0);
  const sam = createSam({ store });
  const v = await sam.run({ phase: 'preflight' });
  assert.equal(store.all('funding_sources').length, allSources().length);
  assert.ok(v.fixed.some((f) => f.area === 'source_registry'));
});

test('Sam reports healthy on a freshly seeded system (no critical findings)', async () => {
  const store = createMemoryStore();
  const sam = createSam({ store });
  const v = await sam.run({ phase: 'preflight' });
  assert.equal(v.healthy, true);
  assert.equal(v.counts.critical, 0);
});

test('Sam clears stale locks as a safe auto-fix', async () => {
  const store = createMemoryStore();
  const now = 10_000_000;
  storage.acquireLock(store, 'old_lock', { now: now - 10 * 60_000 });
  const sam = createSam({ store, lockTtlMs: 5 * 60_000 });
  const v = await sam.run({ phase: 'preflight', now });
  assert.ok(v.fixed.some((f) => f.area === 'locks'));
});

test('Sam confirms the single canonical match authority', async () => {
  const store = createMemoryStore();
  const sam = createSam({ store });
  const v = await sam.run({ phase: 'preflight' });
  const finding = v.findings.find((f) => f.area === 'match_authority');
  assert.ok(finding);
  assert.equal(finding.level, sam.LEVEL.INFO); // INFO == confirmed single authority
});

test('Sam verifies the reality gate still rejects a placeholder probe', async () => {
  const store = createMemoryStore();
  const sam = createSam({ store });
  const v = await sam.run({ phase: 'preflight' });
  const finding = v.findings.find((f) => f.area === 'reality_gate');
  assert.ok(finding);
  assert.equal(finding.level, sam.LEVEL.INFO); // INFO == probe correctly rejected
});

test('Sam flags a stale "running" heartbeat and escalates it', async () => {
  const store = createMemoryStore();
  const now = 20_000_000;
  // a stuck agent: heartbeat says running but is very old
  storage.heartbeat(store, 'robert', { now: now - 30 * 60_000, status: 'running' });
  const sam = createSam({ store, heartbeatStaleMs: 10 * 60_000 });
  const v = await sam.run({ phase: 'postflight', now });
  assert.ok(v.escalations.some((e) => e.category === 'stuck_agent'));
  // escalations are persisted as open agent jobs for the admin
  assert.ok(storage.getAgentJobs(store).some((j) => j.kind === 'escalation'));
});

test('Sam is honest that it cannot edit code in this environment', async () => {
  const store = createMemoryStore();
  const sam = createSam({ store });
  const v = await sam.run({ phase: 'preflight' });
  assert.equal(v.code_edit.capable, false);
  assert.ok(typeof v.code_edit.reason === 'string' && v.code_edit.reason.length > 0);
});
