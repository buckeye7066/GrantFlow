// tests/parsers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiJson } from '../parsers.js';

test('parseApiJson marks required API schema drift as a parse error', () => {
  const out = parseApiJson(JSON.stringify({ data: { wrongKey: [] } }), {
    listPath: 'data.oppHits',
    requiredListPath: true,
    map: { title: 'title' },
  });
  assert.equal(out.error, 'schema_mismatch');
  assert.equal(out.note, 'required_list_path_missing');
  assert.deepEqual(out.candidates, []);
});

test('parseApiJson allows an optional missing list path to be an honest empty result', () => {
  const out = parseApiJson(JSON.stringify({ data: { wrongKey: [] } }), {
    listPath: 'data.oppHits',
    map: { title: 'title' },
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.candidates, []);
});

test('parseApiJson maps rows when the required list path is present', () => {
  const out = parseApiJson(JSON.stringify({ data: { oppHits: [{ title: 'X', agency: 'Y' }] } }), {
    listPath: 'data.oppHits',
    requiredListPath: true,
    map: { title: 'title', sponsor: 'agency' },
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.candidates, [{ title: 'X', sponsor: 'Y' }]);
});
