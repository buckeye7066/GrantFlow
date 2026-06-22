// tests/yana.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createYana } from '../agents/yana.js';
import { storage } from '../index.js';

function candidate(i, over = {}) {
  return {
    name: `Org ${i}`,
    profile_type: 'nonprofit',
    source_url: `https://example${i}.org/about`,
    contact: `info@example${i}.org`,
    needs: ['operating', 'programs'],
    evidence: 'Public page describes a small nonprofit serving the local community with limited funding.',
    ...over,
  };
}

test('Yana qualifies evidence-backed leads and persists them', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store, clock: () => 1_000_000 });
  const res = await yana.run({ candidates: [candidate(1), candidate(2)], now: 1_000_000 });
  assert.equal(res.qualified, 2);
  assert.equal(storage.getLeads(store).length, 2);
});

test('Yana never exposes a send method (she must never email)', () => {
  const yana = createYana({ store: createMemoryStore() });
  assert.equal(typeof yana.send, 'undefined');
  assert.equal(typeof yana.sendEmail, 'undefined');
});

test('Yana caps qualified leads at 50 per rolling 24h', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store });
  const now = 2_000_000_000;
  const many = Array.from({ length: 60 }, (_, i) => candidate(i));
  const res = await yana.run({ candidates: many, now });
  assert.equal(res.qualified, yana.DAILY_QUALIFIED_CAP);
  assert.equal(res.qualified, 50);
  assert.ok(res.deferred >= 10, 'overflow beyond the cap is deferred, not dropped silently');
});

test('Yana deduplicates repeat candidates within and across runs', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store });
  const now = 3_000_000_000;
  await yana.run({ candidates: [candidate(1)], now });
  const res2 = await yana.run({ candidates: [candidate(1)], now: now + 1000 });
  assert.equal(res2.qualified, 0);
  assert.equal(res2.duplicate, 1);
  assert.equal(storage.getLeads(store).length, 1);
});

test('Yana respects the suppression list (by contact email and by domain)', async () => {
  const store = createMemoryStore();
  storage.addSuppression(store, 'info@example1.org', 'email');
  storage.addSuppression(store, 'example2.org', 'domain');
  const yana = createYana({ store });
  const res = await yana.run({ candidates: [candidate(1), candidate(2), candidate(3)], now: 4_000_000_000 });
  assert.equal(res.suppressed, 2);
  assert.equal(res.qualified, 1);
});

test('Yana rejects leads with no public evidence', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store });
  const res = await yana.run({ candidates: [candidate(9, { evidence: null, needs: [], contact: null })], now: 5_000_000_000 });
  assert.equal(res.qualified, 0);
  assert.ok(res.rejections.some((r) => r.reason === 'no_evidence'));
});

test('Yana can use a pluggable discover() provider (production search hook)', async () => {
  const store = createMemoryStore();
  const yana = createYana({
    store,
    discover: async () => [candidate(100), candidate(101)],
  });
  const res = await yana.run({ now: 6_000_000_000 });
  assert.equal(res.qualified, 2);
});
