// tests/john.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createYana } from '../agents/yana.js';
import { createJohn } from '../agents/john.js';
import { storage } from '../index.js';

const ALIAS = 'Ellie@axiombiolabs.org';

function seedQualifiedLead(store, i = 1, over = {}) {
  return storage.saveLead(store, {
    lead_key: `lead_${i}`,
    name: `Org ${i}`,
    profile_type: 'nonprofit',
    source_url: `https://example${i}.org`,
    contact: `info@example${i}.org`,
    fit_score: 80, urgency: 50,
    why: ['has clear funding need'],
    evidence: { text: 'public evidence', needs: ['operating'], domain: `example${i}.org` },
    status: 'qualified',
    ...over,
  });
}

test('John drafts from qualified leads and uses the Ellie alias', async () => {
  const store = createMemoryStore();
  seedQualifiedLead(store, 1);
  const john = createJohn({ store });
  assert.equal(john.alias, ALIAS);
  const res = await john.run({});
  assert.equal(res.drafted, 1);
  const drafts = storage.getDrafts(store);
  assert.equal(drafts[0].alias_from, ALIAS);
  assert.equal(drafts[0].status, 'draft');
});

test('John has NO send method — draft-only by design', () => {
  const john = createJohn({ store: createMemoryStore() });
  assert.equal(typeof john.send, 'undefined');
  assert.equal(typeof john.sendEmail, 'undefined');
});

test('every draft body includes opt-out language and the honest "no guarantees" disclaimer', async () => {
  const store = createMemoryStore();
  seedQualifiedLead(store, 1);
  const john = createJohn({ store });
  await john.run({});
  const body = storage.getDrafts(store)[0].body;
  assert.match(body, /unsubscribe/i);
  assert.match(body, /no guarantees/i); // sets honest expectations, makes no false promises
  assert.ok(body.includes(ALIAS));
});

test('John blocks (does not draft) a suppressed recipient and records the reason', async () => {
  const store = createMemoryStore();
  seedQualifiedLead(store, 1);
  storage.addSuppression(store, 'info@example1.org', 'email');
  const john = createJohn({ store });
  const res = await john.run({});
  assert.equal(res.drafted, 0);
  assert.equal(res.blocked, 1);
  const draft = storage.getDrafts(store)[0];
  assert.equal(draft.status, 'blocked');
  assert.equal(draft.blocked_reason, 'suppressed');
});

test('John does not re-draft a lead that already has a draft', async () => {
  const store = createMemoryStore();
  seedQualifiedLead(store, 1);
  const john = createJohn({ store });
  await john.run({});
  const res2 = await john.run({});
  assert.equal(res2.drafted, 0);
  assert.equal(storage.getDrafts(store).length, 1);
});

test('Yana → John handoff: qualified leads flow straight into drafts', async () => {
  const store = createMemoryStore();
  const yana = createYana({ store });
  await yana.run({
    candidates: [{
      name: 'Riverside Food Bank', profile_type: 'nonprofit',
      source_url: 'https://riverside.org/about', contact: 'hello@riverside.org',
      needs: ['food', 'operating'], evidence: 'Public page describes a food bank with funding gaps.',
    }],
    now: 7_000_000_000,
  });
  const john = createJohn({ store });
  const res = await john.run({});
  assert.equal(res.drafted, 1);
  assert.equal(storage.getDrafts(store)[0].alias_from, ALIAS);
});
