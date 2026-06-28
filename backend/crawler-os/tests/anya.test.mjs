// tests/anya.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../store.js';
import { createAnya } from '../agents/anya.js';

test('Anya explains all 11 pipeline stages in order, in plain language', () => {
  const anya = createAnya({ store: createMemoryStore() });
  const stages = anya.explainStages();
  assert.equal(stages.length, 11);
  assert.equal(stages[0].order, 1);
  assert.equal(stages[0].stage, 'discovered');
  for (const s of stages) assert.ok(typeof s.meaning === 'string' && s.meaning.length > 0);
});

test('Anya routes user intents to the right agent', () => {
  const anya = createAnya({ store: createMemoryStore() });
  assert.equal(anya.route('find me more funding').agent, 'robert');
  assert.equal(anya.route('help me apply and submit').agent, 'hamilton');
  assert.equal(anya.route('new clients and prospects').agent, 'yana');
  assert.equal(anya.route('draft outreach email').agent, 'john');
  assert.equal(anya.route('something is broken / health').agent, 'sam');
});

test('Anya turns a zero-result ladder into honest guidance with next steps', () => {
  const anya = createAnya({ store: createMemoryStore() });
  const run = {
    stored: 0,
    zero_result: {
      zero_result_reason: 'all_sources_skipped',
      searched_sources: [],
      skipped_sources: [{ source_id: 'sam_gov', reason: 'missing_env' }],
      missing_profile_fields: ['location.state'],
      next_steps: ['Provide the missing API keys/env so skipped sources can run.'],
    },
  };
  const out = anya.explainZeroResult(run);
  assert.equal(out.ok, false);
  assert.ok(out.message.length > 0);
  assert.ok(Array.isArray(out.next_steps) && out.next_steps.length > 0);
  // honesty: skipped sources are described as skipped, not faked
  assert.match(out.message, /skipped/i);
});

test('Anya explains a match decision from the canonical match_explain', () => {
  const anya = createAnya({ store: createMemoryStore() });
  const msg = anya.explainMatch({
    decision: 'accept', match_score: 88,
    match_explain: { why: 'score 88/100; needs: equipment; geo: national', warnings: [] },
  });
  assert.match(msg, /strong match/i);
});

test('Anya invents nothing when there is no run to explain', () => {
  const anya = createAnya({ store: createMemoryStore() });
  const out = anya.explainZeroResult({ stored: 2, recommendations: [{}, {}] });
  assert.equal(out.ok, true);
  assert.match(out.message, /2/);
});

test('Anya builds a warm profile-aware project interview from fields and documents', () => {
  const anya = createAnya({ store: createMemoryStore() });
  const out = anya.buildProjectInterview({
    id: 'food-truck-wv',
    profile_type: 'individual',
    location: { city: 'Charleston', state: 'WV' },
    documents: [
      {
        name: 'food-truck-notes.pdf',
        mime_type: 'application/pdf',
        extracted_text: 'Food truck startup. Active duty service member. Need refrigeration and commissary agreement.',
        processing_status: 'completed',
      },
    ],
  });

  assert.match(out.intro, /Good job/i);
  assert.equal(out.plan.plan_id, 'food_truck_startup');
  assert.ok(out.plan.document_evidence.length > 0);
  assert.ok(out.questions.length > 0);
  assert.equal(out.first_question, out.questions[0]);
});
