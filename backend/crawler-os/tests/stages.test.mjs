// tests/stages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_STAGE, PIPELINE_STAGES, TERMINAL_STAGES,
  isValidStage, canTransition, assertTransition,
} from '../stages.js';

test('canonical pipeline is exactly the 11 doctrine stages in order', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'discovered', 'saved', 'interested', 'gathering_documents', 'drafting',
    'ready_to_submit', 'submitted', 'follow_up', 'awarded', 'declined', 'archived',
  ]);
  assert.equal(PIPELINE_STAGES.length, 11);
});

test('isValidStage accepts canonical stages and rejects junk', () => {
  assert.equal(isValidStage(PIPELINE_STAGE.DISCOVERED), true);
  assert.equal(isValidStage('awarded'), true);
  assert.equal(isValidStage('in_progress'), false);
  assert.equal(isValidStage(undefined), false);
});

test('canTransition allows a sensible forward move', () => {
  assert.equal(canTransition('discovered', 'saved'), true);
  assert.equal(canTransition('drafting', 'ready_to_submit'), true);
});

test('terminal stages cannot transition onward', () => {
  for (const t of TERMINAL_STAGES) {
    assert.equal(canTransition(t, 'saved'), false, `${t} is terminal`);
  }
});

test('assertTransition throws loudly on an illegal move', () => {
  // backward more than one step is illegal
  assert.throws(() => assertTransition('ready_to_submit', 'discovered'));
  // a terminal stage cannot move to a non-archived stage
  assert.throws(() => assertTransition('awarded', 'saved'));
  // unknown target stage
  assert.throws(() => assertTransition('saved', 'not_a_stage'));
});

test('forward skips ahead are allowed but large backward jumps are not', () => {
  assert.equal(canTransition('discovered', 'awarded'), true);    // skip ahead OK
  assert.equal(canTransition('ready_to_submit', 'drafting'), true);  // one step back OK
  assert.equal(canTransition('ready_to_submit', 'discovered'), false); // too far back
});

test('assertTransition returns normally on a legal move', () => {
  assert.doesNotThrow(() => assertTransition('interested', 'gathering_documents'));
});
