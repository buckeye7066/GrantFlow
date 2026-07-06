// tests/applicantTypePrecision.test.mjs
//
// The Axiom BioLabs class (2026-07-06): a free-text declared org type
// ("Biotechnology / research organization") fell through every exact map and
// synonym, hit the blob-scan fallback, and substring matching exploded to 13
// applicant buckets ('ets' inside "targets" → transitioning_service_member,
// 'ems' inside "systems" → vfd). These pin the fixes:
//   1. org-shaped declared text maps to the generic org buckets (no fallback),
//   2. the true fallback uses word-boundary matching,
//   3. section field NAMES with false values never leak into the blob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThesis } from '../profileIntelligence.js';
// NOTE: sectionSignalText (services/crawlerOsPersistence.js) is tested in
// backend/tests/sectionSignalText.test.js — the OS isolation rule forbids
// importing services from crawler-os tests.

test('a free-text declared research org gets org buckets, never the 13-bucket explosion', () => {
  const thesis = buildThesis({
    profile_type: 'Biotechnology / research organization',
    name: 'Axiom BioLabs',
    sections: [
      { title: 'narrative', body: 'Advancing biotechnological research targets and assets for public health systems.' },
    ],
    location: { state: 'TN', city: 'Cleveland' },
  });
  assert.ok(thesis.applicant_types.includes('nonprofit'), 'org bucket present');
  assert.ok(thesis.applicant_types.includes('business'), 'business bucket present');
  for (const junk of ['veteran', 'transitioning_service_member', 'family', 'teacher', 'farm', 'tribal', 'individual']) {
    assert.ok(!thesis.applicant_types.includes(junk), `must not contain '${junk}'`);
  }
  assert.equal(thesis.is_research_org, true);
});

test('the no-identity blob fallback matches on word boundaries, not substrings', () => {
  // No declared identity at all; blob contains 'targets'/'systems'/'assets'
  // which CONTAIN 'ets'/'ems' but are not those words.
  const thesis = buildThesis({
    name: 'Mystery Profile',
    sections: [
      { title: 'narrative', body: 'We manage systems and assets and set targets.' },
    ],
  });
  assert.ok(!thesis.applicant_types.includes('transitioning_service_member'), "'ets' inside 'targets' must not match");
  assert.ok(!thesis.applicant_types.includes('vfd'), "'ems' inside 'systems' must not match");
});

test('the fallback still works for genuine free-text identity words', () => {
  const thesis = buildThesis({
    name: 'Bare Profile',
    sections: [{ title: 'about', body: 'I am a veteran seeking help.' }],
  });
  assert.ok(thesis.applicant_types.includes('veteran'), 'real word-boundary identity still inferred');
});
