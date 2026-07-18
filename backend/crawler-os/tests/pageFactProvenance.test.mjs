// tests/pageFactProvenance.test.mjs
//
// Phase 0.1 web-lane de-contamination — durable page-fact provenance is
// ADDITIVE, NULL-default plumbing. These tests pin two facts:
//   1. an opportunity that sets NONE of the new fields is shaped IDENTICALLY to
//      before (the new fields default null/empty and nothing else moves), and
//   2. when the fields ARE provided they round-trip write->read through the
//      canonical contract shape and the storage layer faithfully — proving the
//      plumbing a later profile-blind extractor will populate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createMemoryStore, createSqlStore } from '../store.js';
import { storage, applySchema } from '../index.js';
import { makeOpportunity, OPPORTUNITY_KIND, REALITY_STATUS, TRUST_TIER } from '../contract.js';
import { computeMatchDecision } from '../matchEngine.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE } from './fixtures/fakeFetch.mjs';
import {
  PAGE_FACT_COLUMNS, PAGE_FACT_MIGRATION_COLUMNS, PAGE_FACT_TRISTATE_FIELDS,
  PAGE_FACT_OS_STORE_COLUMNS,
  cleanEligibilityBullets, cleanFieldProvenance, cleanSchemaVersion, mergeFieldProvenance,
  buildLivePageFactColumns, buildOsStorePageFactColumns,
} from '../pageFacts.js';
import { SCHEMA_DDL } from '../storage.js';

function baseInput(over = {}) {
  return {
    id: 'pf-1', source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Rural Facilities Grant', sponsor: 'USDA',
    apply_url: 'https://www.grants.gov/d/pf-1',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
    ...over,
  };
}

test('makeOpportunity: page-fact fields default null/empty when unset', () => {
  const opp = makeOpportunity(baseInput());
  assert.equal(opp.eligibility_text, null);
  assert.deepEqual(opp.eligibility_bullets, []);
  assert.equal(opp.page_fact_schema_version, null);
  assert.equal(opp.field_provenance, null);
  // The rest of the canonical shape is unchanged — the booleans still coalesce.
  assert.equal(opp.funding.is_loan, false);
  assert.equal(opp.funding.requires_cost_share, false);
  assert.equal(opp.geography.national, false);
});

test('makeOpportunity: page-fact fields are carried when provided', () => {
  const provenance = {
    is_loan: { value: false, evidence_snippet: 'This is a grant, not a loan.', source: 'https://x/1' },
    national: { value: true, evidence_snippet: 'Open to applicants nationwide.', source: 'https://x/1' },
    eligibility_text: { value: '501(c)(3) nonprofits in rural counties.', evidence_snippet: 'Who may apply: 501(c)(3)…', source: 'https://x/1' },
  };
  const opp = makeOpportunity(baseInput({
    eligibility_text: '501(c)(3) nonprofits in rural counties.',
    eligibility_bullets: ['Must be a 501(c)(3)', 'Rural county'],
    page_fact_schema_version: 1,
    field_provenance: provenance,
  }));
  assert.equal(opp.eligibility_text, '501(c)(3) nonprofits in rural counties.');
  assert.deepEqual(opp.eligibility_bullets, ['Must be a 501(c)(3)', 'Rural county']);
  assert.equal(opp.page_fact_schema_version, 1);
  assert.deepEqual(opp.field_provenance, provenance);
  // Tri-state: an ABSENT key in field_provenance means "not stated"; a present
  // key with value:false means stated-false — distinct facts.
  assert.equal(opp.field_provenance.is_loan.value, false);
  assert.equal('requires_cost_share' in opp.field_provenance, false);
});

test('storage round-trip: unset page-fact fields persist as null/empty', () => {
  const store = createMemoryStore();
  assert.equal(storage.upsertOpportunity(store, makeOpportunity(baseInput())).stored, true);
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, null);
  assert.equal(row.eligibility_bullets_json, '[]');
  assert.equal(row.page_fact_schema_version, null);
  assert.equal(row.field_provenance_json, null);
});

test('storage round-trip: provided page-fact fields survive write->read', () => {
  const store = createMemoryStore();
  const provenance = { national: { value: true, evidence_snippet: 'nationwide', source: 'https://x/1' } };
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    eligibility_text: 'Nonprofits only.',
    eligibility_bullets: ['Must be a nonprofit'],
    page_fact_schema_version: 2,
    field_provenance: provenance,
  })));
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, 'Nonprofits only.');
  assert.deepEqual(JSON.parse(row.eligibility_bullets_json), ['Must be a nonprofit']);
  assert.equal(row.page_fact_schema_version, 2);
  assert.deepEqual(JSON.parse(row.field_provenance_json), provenance);
});

test('matchEngine facade: page-fact fields change NO score or decision', () => {
  const thesis = buildThesis(SAMPLE_VFD_PROFILE);
  const strong = {
    source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Assistance to Firefighters Grant', sponsor: 'FEMA',
    applicant_types: ['vfd'], need_categories: ['equipment', 'emergency'],
    geography: { national: true }, funding: { amount_max: 50000 },
    deadline: new Date(Date.now() + 20 * 86400000).toISOString(),
    apply_url: 'https://www.fema.gov/grants/afg/apply',
    trust_tier: TRUST_TIER.OFFICIAL_API, reality_status: REALITY_STATUS.VERIFIED,
  };
  const withoutFacts = computeMatchDecision(makeOpportunity(strong), thesis);
  const withFacts = computeMatchDecision(makeOpportunity({
    ...strong,
    eligibility_text: 'Volunteer fire departments may apply.',
    eligibility_bullets: ['Must be a recognized VFD'],
    page_fact_schema_version: 1,
    field_provenance: {
      is_loan: { value: false, evidence_snippet: 'grant', source: 'https://x' },
      national: { value: true, evidence_snippet: 'nationwide', source: 'https://x' },
    },
  }), thesis);
  assert.equal(withFacts.match_score, withoutFacts.match_score);
  assert.equal(withFacts.decision, withoutFacts.decision);
});

// ---- finding #1: a re-crawl / dedup must never NULL-out stored provenance ----

test('same-id re-crawl WITHOUT facts preserves previously-stored provenance', () => {
  const store = createMemoryStore();
  const provenance = { is_loan: { value: false, evidence_snippet: 'grant', source: 'https://x/1' } };
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    eligibility_text: 'Nonprofits only.',
    eligibility_bullets: ['Must be a nonprofit'],
    page_fact_schema_version: 2,
    field_provenance: provenance,
  })));
  // A later run of the SAME opportunity that learned no page facts.
  storage.upsertOpportunity(store, makeOpportunity(baseInput()));
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, 'Nonprofits only.');
  assert.deepEqual(JSON.parse(row.eligibility_bullets_json), ['Must be a nonprofit']);
  assert.equal(row.page_fact_schema_version, 2);
  assert.deepEqual(JSON.parse(row.field_provenance_json), provenance);
});

test('same-id re-crawl MERGES provenance per canonical field (new key added, old kept)', () => {
  const store = createMemoryStore();
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    field_provenance: { is_loan: { value: false, source: 'https://x/1' } },
  })));
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    field_provenance: { national: { value: true, source: 'https://x/2' } },
  })));
  const merged = JSON.parse(storage.getOpportunity(store, 'pf-1').field_provenance_json);
  assert.equal(merged.is_loan.value, false); // preserved
  assert.equal(merged.national.value, true); // added
});

test('cross-source dedup MERGES newly-supplied facts into the canonical row', () => {
  const store = createMemoryStore();
  // First crawler stores the canonical row (same canonical key via same title+sponsor+url).
  storage.upsertOpportunity(store, makeOpportunity({
    id: 'src-a', source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Shared Program', sponsor: 'USDA', apply_url: 'https://ex.gov/p',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
  }));
  // A DIFFERENT source (different id, same canonical key) supplies page facts.
  const res = storage.upsertOpportunity(store, makeOpportunity({
    id: 'src-b', source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Shared Program', sponsor: 'USDA', apply_url: 'https://ex.gov/p',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
    eligibility_text: 'Open to rural nonprofits.',
    field_provenance: { national: { value: true, source: 'https://ex.gov/p' } },
  }));
  assert.equal(res.deduped, true);
  const row = storage.getOpportunity(store, 'src-a'); // the canonical row
  assert.equal(row.eligibility_text, 'Open to rural nonprofits.');
  assert.deepEqual(JSON.parse(row.field_provenance_json), { national: { value: true, source: 'https://ex.gov/p' } });
});

// ---- finding #3 (storage layer): blanks / empty / malformed are NOT facts ----

test('blank / empty / malformed page facts never overwrite stored values', () => {
  const store = createMemoryStore();
  const provenance = { is_loan: { value: false, source: 'https://x/1' } };
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    eligibility_text: 'Real text.', eligibility_bullets: ['A bullet'],
    page_fact_schema_version: 3, field_provenance: provenance,
  })));
  // Re-crawl carrying only blanks / empties / a non-positive version.
  storage.upsertOpportunity(store, makeOpportunity(baseInput({
    eligibility_text: '   ', eligibility_bullets: [], page_fact_schema_version: 0,
    field_provenance: {},
  })));
  const row = storage.getOpportunity(store, 'pf-1');
  assert.equal(row.eligibility_text, 'Real text.');
  assert.deepEqual(JSON.parse(row.eligibility_bullets_json), ['A bullet']);
  assert.equal(row.page_fact_schema_version, 3);
  assert.deepEqual(JSON.parse(row.field_provenance_json), provenance);
});

test('validators reject blanks, non-positive/non-integer versions, and malformed JSON', () => {
  assert.equal(cleanSchemaVersion(''), null);
  assert.equal(cleanSchemaVersion(0), null);
  assert.equal(cleanSchemaVersion(-2), null);
  assert.equal(cleanSchemaVersion(1.5), null);
  assert.equal(cleanSchemaVersion('2'), 2);
  assert.equal(cleanFieldProvenance('{}'), null);
  assert.equal(cleanFieldProvenance('[]'), null);
  assert.equal(cleanFieldProvenance('not json'), null);
  assert.equal(cleanFieldProvenance({ k: 'scalar-not-evidence' }), null);
  assert.deepEqual(mergeFieldProvenance('{}', { a: { value: 1 } }), { a: { value: 1 } });
});

// ---- finding #2: validators must not COERCE malformed structured values -----

test('cleanEligibilityBullets drops non-string items (never "[object Object]")', () => {
  assert.deepEqual(cleanEligibilityBullets([{}]), []);
  assert.deepEqual(cleanEligibilityBullets(['ok', {}, 42, null, ' trim ']), ['ok', 'trim']);
  assert.deepEqual(cleanEligibilityBullets('[{}]'), []);
});

test('cleanSchemaVersion rejects booleans and objects (no Number(true)===1 coercion)', () => {
  assert.equal(cleanSchemaVersion(true), null);
  assert.equal(cleanSchemaVersion(false), null);
  assert.equal(cleanSchemaVersion({}), null);
  assert.equal(cleanSchemaVersion([]), null);
  assert.equal(cleanSchemaVersion(3), 3);
});

test('cleanFieldProvenance drops entries with no own `value`, and they never overwrite good evidence', () => {
  // An entry that is a bare {} (no `value`) is not evidence — dropped.
  assert.equal(cleanFieldProvenance({ is_loan: {} }), null);
  assert.deepEqual(cleanFieldProvenance({ is_loan: {}, national: { value: true } }), { national: { value: true } });
  // During a merge, a value-less incoming entry cannot clobber a stored one.
  const good = { is_loan: { value: false, source: 'https://x/1' } };
  assert.deepEqual(mergeFieldProvenance(good, { is_loan: {} }), good);
});

// ---- finding #3: the registry actually DRIVES the real consumers ------------

test('registry drives the OS-store schema surface (SCHEMA_DDL + applySchema)', () => {
  for (const c of PAGE_FACT_COLUMNS) assert.ok(SCHEMA_DDL.includes(c.osStoreColumn), `SCHEMA_DDL declares ${c.osStoreColumn}`);
  const raw = new Database(':memory:');
  applySchema(raw);
  const cols = new Set(raw.prepare('PRAGMA table_info(funding_opportunities)').all().map((r) => r.name));
  for (const name of PAGE_FACT_OS_STORE_COLUMNS) assert.ok(cols.has(name), `applySchema created ${name}`);
  raw.close();
});

test('buildOsStorePageFactColumns emits EXACTLY the registry OS-store columns', () => {
  const emitted = Object.keys(buildOsStorePageFactColumns(null, makeOpportunity(baseInput({
    eligibility_text: 't', eligibility_bullets: ['b'], page_fact_schema_version: 1,
    field_provenance: { is_loan: { value: false } },
  }))));
  assert.deepEqual(emitted.sort(), [...PAGE_FACT_OS_STORE_COLUMNS].sort());
});

test('buildLivePageFactColumns maps EXACTLY the registry live columns when all facts present', () => {
  const osRow = {
    eligibility_text: 'Nonprofits only.',
    eligibility_bullets_json: JSON.stringify(['A bullet']),
    page_fact_schema_version: 2,
    field_provenance_json: JSON.stringify({ national: { value: true } }),
  };
  const emitted = Object.keys(buildLivePageFactColumns(osRow));
  assert.deepEqual(emitted.sort(), PAGE_FACT_COLUMNS.map((c) => c.liveColumn).sort());
  // ...and NOTHING is emitted for an all-empty row.
  assert.deepEqual(buildLivePageFactColumns({}), {});
});

// ---- finding #2: applySchema heals the OS-store columns on a pre-change DB ----

test('applySchema heals page-fact columns so an UNSET upsert works on an upgraded store', () => {
  const raw = new Database(':memory:');
  applySchema(raw);
  // Simulate an origin/main OS database that predates the page-fact columns.
  for (const c of ['eligibility_text', 'eligibility_bullets_json', 'page_fact_schema_version', 'field_provenance_json']) {
    raw.exec(`ALTER TABLE funding_opportunities DROP COLUMN ${c}`);
  }
  // Re-heal (this is what a boot after the upgrade does) and use the SQL store.
  applySchema(raw);
  const store = createSqlStore(raw);
  // An UNSET upsert names all four internal columns — must not throw now.
  const res = storage.upsertOpportunity(store, makeOpportunity({
    id: 'up-1', source_id: 'grants_gov', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Upgraded Store Grant', sponsor: 'USDA', apply_url: 'https://ex.gov/u',
    reality_status: REALITY_STATUS.VERIFIED, trust_tier: TRUST_TIER.OFFICIAL_API,
  }));
  assert.equal(res.stored, true);
  const row = storage.getOpportunity(store, 'up-1');
  assert.equal(row.eligibility_text, null);
  assert.equal(row.field_provenance_json, null);
  raw.close();
});

// ---- finding #5: one registry, explicit OS->live mappings, totality ---------

test('page-fact registry is total and reconciles the OS/live vocabularies', () => {
  // Every column carries both an OS-store and a live column name.
  for (const c of PAGE_FACT_COLUMNS) {
    assert.ok(c.osStoreColumn && c.liveColumn && c.field, `column ${c.field} fully mapped`);
  }
  // Migration columns are a subset of the live column names and EXCLUDE the
  // pre-existing eligibility_bullets.
  const liveCols = new Set(PAGE_FACT_COLUMNS.map((c) => c.liveColumn));
  for (const m of PAGE_FACT_MIGRATION_COLUMNS) assert.ok(liveCols.has(m.column), `${m.column} is a live page-fact column`);
  assert.equal(PAGE_FACT_MIGRATION_COLUMNS.some((m) => m.column === 'eligibility_bullets'), false);
  // The tri-state fields map the canonical provenance key to its live boolean.
  const byKey = Object.fromEntries(PAGE_FACT_TRISTATE_FIELDS.map((f) => [f.provenanceKey, f.liveColumn]));
  assert.equal(byKey.is_loan, 'is_loan');
  assert.equal(byKey.requires_cost_share, 'requires_match');
  assert.equal(byKey.national, 'is_national');
  for (const f of PAGE_FACT_TRISTATE_FIELDS) {
    assert.ok(f.osFundingKey || f.osGeographyKey, `${f.provenanceKey} names an OS source key`);
  }
});
