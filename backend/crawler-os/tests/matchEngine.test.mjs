// tests/matchEngine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeMatchDecision, MATCHER_VERSION, WEIGHTS } from '../matchEngine.js';
import { matchOpportunity } from '../matcher.js';
import { makeOpportunity, MATCH_DECISION, OPPORTUNITY_KIND, TRUST_TIER, REALITY_STATUS } from '../contract.js';
import { buildThesis } from '../profileIntelligence.js';
import { SAMPLE_VFD_PROFILE, SAMPLE_VFD_SECTIONS } from './fixtures/fakeFetch.mjs';
import { computeMatchDecision as canonicalComputeMatchDecision, MATCHER_VERSION as CANONICAL_MATCHER_VERSION } from '../../services/matchEngine.js';

const thesis = buildThesis(SAMPLE_VFD_PROFILE);
// Full-context fixtures — the shape runProfileDiscoveryLive supplies for the
// PRIMARY profile (2026-07-27). Calibrated coverage claims (and therefore
// ACCEPT decisions) require a real data-point inventory
// (MIN_CALIBRATED_INVENTORY); a bare thesis stub is capped at the topical
// bound so broad directories can never read as "Excellent Match" for every
// profile again (the identical Anita/Demo Student junk-lists class). Person
// profiles mine sections into rich signal inventories (real prod profiles
// measure 19-66+ through this same path), so the calibrated-path fixtures
// below use a student.
const STUDENT_THESIS = buildThesis({
  id: 'p_stu', type: 'student', state: 'TN', needs: ['education', 'housing'],
  location: { state: 'TN', city: 'Murfreesboro' },
  school: { name: 'Middle Tennessee State University', type: 'university' },
});
const STUDENT_CTX = {
  profileRow: {
    id: 'p_stu', display_name: 'Jordan Lee', primary_type: 'student',
    state: 'TN', city: 'Murfreesboro', zip: '37132',
    needs: ['education', 'housing'], interests: ['nursing', 'community health'],
    tags: ['first generation'],
  },
  profileSections: {
    basic_information: {
      first_name: 'Jordan', last_name: 'Lee', state: 'TN', city: 'Murfreesboro',
      zip_code: '37132', email: 'jordan@example.edu', phone: '615-555-0101',
      date_of_birth: '2006-02-01', gender: 'female',
    },
    education: {
      school_name: 'Middle Tennessee State University', enrollment_status: 'enrolled_full_time',
      gpa: 3.7, intended_major: 'Nursing', expected_graduation: '2028', fafsa_completed: true,
    },
    financial_information: { household_income: 32000, household_size: 4, funding_amount_needed: 8000 },
    housing: { housing_status: 'renting', monthly_rent: 850, housing_need: 'off-campus housing' },
    demographics: { first_generation: true },
  },
};
function studentOpp(over = {}) {
  return makeOpportunity({
    source_id: 'tn_tsac', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Tennessee Student Assistance Award', sponsor: 'TSAC',
    applicant_types: ['student'], need_categories: ['education'],
    geography: { states: ['TN'] }, funding: { amount_max: 4000 },
    deadline: new Date(Date.now() + 40 * 86400000).toISOString(),
    apply_url: 'https://www.tn.gov/collegepays/tsaa/apply',
    trust_tier: TRUST_TIER.OFFICIAL_HTML, reality_status: REALITY_STATUS.VERIFIED,
    ...over,
  });
}

function strongOpp(over = {}) {
  return makeOpportunity({
    source_id: 'fema_afg', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Assistance to Firefighters Grant', sponsor: 'FEMA',
    applicant_types: ['vfd'], need_categories: ['equipment', 'emergency'],
    geography: { national: true },
    funding: { amount_max: 50000 },
    deadline: new Date(Date.now() + 20 * 86400000).toISOString(),
    apply_url: 'https://www.fema.gov/grants/afg/apply',
    trust_tier: TRUST_TIER.OFFICIAL_API, reality_status: REALITY_STATUS.VERIFIED,
    ...over,
  });
}

test('the decision triad is exactly accept / review / reject (lowercase)', () => {
  assert.deepEqual(MATCH_DECISION, { ACCEPT: 'accept', REVIEW: 'review', REJECT: 'reject' });
});

test('a strong, well-matched grant ACCEPTs with a high score (full profile context)', () => {
  const m = computeMatchDecision(studentOpp(), STUDENT_THESIS, STUDENT_CTX);
  assert.equal(m.decision, MATCH_DECISION.ACCEPT);
  // Data-point scale: 11 is the ACCEPT band (top ~quarter of real matches).
  // The old ">= 70" expectation was calibrated against the inflated stub-
  // inventory scoring the MIN_CALIBRATED_INVENTORY floor exists to kill.
  assert.ok(m.match_score >= 11, `expected >= 11 (data-point ACCEPT band), got ${m.match_score}`);
  // The calibrated sentence is present — and never claims more matched
  // points than the inventory holds.
  const sentence = m.match_explain.warnings.find((w) => /data points — \d+% coverage/.test(w));
  assert.ok(sentence, 'full-context scoring must carry the calibrated coverage sentence');
  const [, matched, total] = sentence.match(/Matches (\d+) of the profile's (\d+) data points/);
  assert.ok(Number(matched) <= Number(total), sentence);
  assert.equal(m.opportunity_id, studentOpp().id);
  assert.equal(m.profile_id, STUDENT_THESIS.profile_id);
  assert.ok(Number.isFinite(m.match_confidence), 'canonical confidence must survive the OS facade');
  assert.ok(m.match_confidence >= 0 && m.match_confidence <= 100);
});

test('a context-less thesis stub can never mint a calibrated ACCEPT (topical cap)', () => {
  // The exact class behind the identical Anita/Demo Student junk lists: a stub
  // inventory of ~6 points made every broad row "cover" 50-100% of every
  // profile. Without context the same strong grant stays reachable but
  // bounded — and can never claim the calibrated coverage sentence.
  const m = computeMatchDecision(strongOpp(), thesis);
  assert.ok(m.match_score <= 13, `stub scoring must stay at/below the topical cap (13), got ${m.match_score}`);
  assert.notEqual(m.decision, MATCH_DECISION.REJECT, 'bounded, not discarded (G4)');
});

test('a topically-irrelevant grant (no specific need overlap) is capped at REVIEW, never ACCEPT', () => {
  // Open to the profile's applicant type, national, official, funded — but its
  // only need overlap is the catch-all 'programs'. A VFD needing equipment/
  // emergency should NOT see this as an apply-now ACCEPT.
  const offTopic = strongOpp({
    title: 'U.S. Mission Cultural Exchange Program',
    need_categories: ['programs'],
  });
  const m = computeMatchDecision(offTopic, thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT, `off-topic grant must not ACCEPT (got ${m.decision} @ ${m.match_score})`);
  assert.ok(m.match_score < 70, `off-topic grant must stay below ACCEPT territory, got ${m.match_score}`);
  assert.ok(m.match_explain.warnings.length >= 1, 'canonical warnings should explain the downgrade');
});

test('a multi-need profile is NOT penalized for a focused grant — one real specific-need match scores well', () => {
  // Regression for the 2026-06-23 false-NEGATIVE: need = matched/total meant a
  // profile listing 4 needs that matched a grant on exactly ONE got 1/4 credit
  // and the genuinely-relevant grant was REJECTED. Full credit comes at
  // NEED_FULL_CREDIT_HITS specific overlaps, so one strong specific match alone
  // earns at least half of the need weight (not a quarter).
  const multiNeed = buildThesis({
    id: 'p_multi', profile_type: 'nonprofit', applicant_types: ['nonprofit'],
    needs: ['capital', 'operations', 'programs', 'education'],
    location: { state: 'TN' },
  });
  const focused = strongOpp({
    source_id: 'community_foundation',
    title: 'Community Capital Facilities Grant', sponsor: 'Community Foundation',
    applicant_types: ['nonprofit'],
    need_categories: ['capital'], geography: { states: ['TN'] },
    apply_url: 'https://example.org/community-capital-facilities',
  });
  // Full context for the nonprofit — calibrated claims require a real
  // inventory (2026-07-27); a bare thesis is capped at the topical bound.
  const m = computeMatchDecision(focused, multiNeed, {
    profileRow: {
      id: 'p_multi', display_name: 'Multi Need Community Org', primary_type: 'nonprofit',
      state: 'TN', city: 'Nashville', zip: '37201',
      needs: ['capital', 'operations', 'programs', 'education'],
      tags: ['community organization', 'capital projects', 'general operating'],
      interests: ['facility improvement', 'community education', 'capacity building'],
      keywords: ['building renovation', 'program expansion', 'operating support', 'construction'],
      funding_amount_needed: 50000,
    },
  });
  assert.ok(m.match_explain.matched_needs.includes('capital'), 'focused grant should name the matched profile need');
  // DATA-POINT scale (2026-07-06 evening): 8 is the pipeline bar
  // (AUTO_ADD/DISCOVERY_MIN_SCORE_FLOOR). The intent this test protects is
  // unchanged across scale moves: a genuinely-relevant focused grant must
  // reach the pipeline and must never be REJECTED for being focused.
  assert.ok(m.match_score >= 8, `focused grant must reach the pipeline bar (8, data-point scale), got ${m.match_score}`);
  assert.notEqual(m.decision, MATCH_DECISION.REJECT, `a real specific-need match must not be rejected (got ${m.decision} @ ${m.match_score})`);
});

test('the result carries an explainable breakdown and reasons', () => {
  const m = computeMatchDecision(strongOpp(), thesis);
  assert.ok(m.match_explain);
  assert.ok(m.match_explain.score_breakdown);
  assert.ok(typeof m.match_explain.why === 'string');
  assert.equal(m.match_explain.matched_profile_type, true);
  assert.equal(m.match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
  assert.ok(Array.isArray(m.match_explain.matched_profile_facts));
});

test('full context + accept-level coverage: the locator demotion and #886 no-apply-URL guards still fire', () => {
  // A topically strong DIRECTORY for a rich student context would reach the
  // calibrated ACCEPT band — the demotion rule must convert it to REVIEW with
  // the pointer warning (the "Recommended != strong match" locator rule).
  const dir = studentOpp({
    kind: OPPORTUNITY_KIND.DIRECTORY, apply_url: null,
    info_url: 'https://studentaid.example.gov/finder',
    title: 'Tennessee student aid finder',
  });
  const d1 = computeMatchDecision(dir, STUDENT_THESIS, STUDENT_CTX);
  assert.notEqual(d1.decision, MATCH_DECISION.ACCEPT);
  if (d1.match_score >= 11) {
    assert.ok(d1.match_explain.warnings.some((w) => /pointer to look through/i.test(w)),
      `an accept-level locator must carry the demotion warning (score ${d1.match_score})`);
  }

  // Same strong fit as a PROGRAM with no apply target: held at REVIEW with
  // the explicit #886 warning.
  const program = studentOpp({ kind: 'PROGRAM', apply_url: null, info_url: 'https://studentaid.example.gov/tsaa' });
  const d2 = computeMatchDecision(program, STUDENT_THESIS, STUDENT_CTX);
  assert.equal(d2.decision, MATCH_DECISION.REVIEW);
  assert.ok(d2.match_explain.warnings.some((w) => /no direct application URL/i.test(w)),
    `accept-level PROGRAM without apply target must carry the #886 warning (score ${d2.match_score})`);
});

test('a directory is never an ACCEPT — it goes to REVIEW', () => {
  const dir = makeOpportunity({
    source_id: 'cof_locator', kind: OPPORTUNITY_KIND.DIRECTORY,
    title: 'Foundation Locator', sponsor: 'COF', geography: { national: true },
    info_url: 'https://cof.org/locator', reality_status: REALITY_STATUS.DIRECTORY,
  });
  const m = computeMatchDecision(dir, thesis);
  assert.equal(m.decision, MATCH_DECISION.REVIEW);
});

test('a loan the profile disallows is downgraded to REVIEW (warned), never silently ACCEPTed', () => {
  const m = computeMatchDecision(strongOpp({ funding: { amount_max: 50000, is_loan: true } }), thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT);
  assert.ok(m.match_explain.warnings.some((w) => /loan/i.test(w)));
});

test('an unrelated opportunity stays low and never ACCEPTs', () => {
  const weak = makeOpportunity({
    source_id: 'x', kind: OPPORTUNITY_KIND.DIRECT_GRANT,
    title: 'Unrelated Arts Microgrant', sponsor: 'Some Council',
    applicant_types: ['individual'], need_categories: ['arts'],
    geography: { national: false, states: ['CA'] },
    apply_url: 'https://example.org/apply', trust_tier: TRUST_TIER.UNVERIFIED,
    reality_status: REALITY_STATUS.LINK_UNVERIFIED,
  });
  const m = computeMatchDecision(weak, thesis);
  assert.notEqual(m.decision, MATCH_DECISION.ACCEPT);
  assert.ok(m.match_score < 50, `expected a low score for unrelated opportunity, got ${m.match_score}`);
});

test('an explicit floor override is honored', () => {
  const m = computeMatchDecision(studentOpp(), STUDENT_THESIS, { floor: 99, ...STUDENT_CTX });
  assert.equal(m.match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
  assert.equal(m.decision, MATCH_DECISION.ACCEPT, 'OS floor is a display/filter concern; canonical thresholds decide');
});

test('wildcard applicant markers stay neutral, not a fake applicant identity', () => {
  const broadThesis = {
    profile_id: 'p_broad',
    applicant_types: ['*'],
    needs: ['equipment'],
    location: {},
    loan_allowed: false,
    cost_share_allowed: false,
  };
  const nonprofitOnly = strongOpp({
    title: 'Equipment Grant for Nonprofits',
    sponsor: 'Community Foundation',
    applicant_types: ['nonprofit'],
    need_categories: ['equipment'],
  });
  const m = computeMatchDecision(nonprofitOnly, broadThesis);
  assert.equal(m.decision, MATCH_DECISION.REVIEW);
  assert.equal(m.match_explain.matched_profile_type, false);
  assert.equal(m.match_explain.score_breakdown.applicant_type, 0);
  assert.ok(m.match_explain.missing_eligibility_fields.includes('entity_type'));
  assert.ok(m.match_explain.missing_eligibility_fields.includes('nonprofit_status'));
  assert.ok(!m.match_explain.warnings.some((w) => /\*/.test(w) || /profile is \*/i.test(w)));
  assert.ok(!m.match_explain.matched_profile_facts.some((fact) => /\*/.test(fact)));
});

test('matcher.matchOpportunity uses the OS facade, which delegates to the canonical engine', () => {
  assert.equal(matchOpportunity, computeMatchDecision);
  assert.equal(MATCHER_VERSION, CANONICAL_MATCHER_VERSION);
  assert.equal(computeMatchDecision(strongOpp(), thesis).match_explain.matcher_version, CANONICAL_MATCHER_VERSION);
});

test('OS facade and canonical engine agree on score and decision after shape mapping', () => {
  const opp = strongOpp();
  const osDecision = computeMatchDecision(opp, thesis);
  const canonicalDecision = canonicalComputeMatchDecision({
    id: thesis.profile_id,
    applicant_type: 'volunteer_fire_department',
    primary_type: 'volunteer_fire_department',
    type: 'volunteer_fire_department',
    applicantTypes: new Set(['volunteer_fire_department', 'vfd', 'government', 'nonprofit', 'organization']),
    needs: thesis.needs,
    need_categories: thesis.needs,
    state: thesis.location.state,
    zip: thesis.location.zip,
    county: thesis.location.county,
    location: thesis.location,
    tags: [...thesis.needs, ...thesis.applicant_types],
  }, {
    id: opp.id,
    title: opp.title,
    sponsor: opp.sponsor,
    funder: opp.sponsor,
    description: [
      opp.summary,
      `Eligible applicants: ${opp.applicant_types.join(', ')}`,
      `Funding needs: ${opp.need_categories.join(', ')}`,
    ].filter(Boolean).join('\n'),
    entity_types_allowed: ['nonprofit', 'organization'],
    need_types_supported: opp.need_categories,
    categories: [...opp.need_categories, 'nonprofit', 'organization', ...opp.applicant_types],
    eligibility_bullets: ['Eligible applicants: vfd, nonprofit, organization'],
    keywords: [...opp.need_categories, ...opp.applicant_types, 'nonprofit', 'organization', opp.source_id, opp.kind, opp.sponsor],
    state: 'nationwide',
    is_national: true,
    amount_min: null,
    amount_max: opp.funding.amount_max,
    is_loan: false,
    requires_match: false,
    deadline: opp.deadline,
    deadline_type: null,
    application_url: opp.apply_url,
    apply_url: opp.apply_url,
    source_url: opp.apply_url,
    url: opp.apply_url,
    type: opp.kind,
    opportunity_type: 'grant',
    source: opp.source_id,
    record_origin: 'crawler_os',
    trust_tier: opp.trust_tier,
    reality_status: opp.reality_status,
  });
  assert.equal(osDecision.match_score, canonicalDecision.score);
  assert.equal(osDecision.decision.toUpperCase(), canonicalDecision.decision);
});

test('OS matcher source contains no standalone scoring weights or decide function', () => {
  const source = fs.readFileSync(path.resolve('backend/crawler-os/matchEngine.js'), 'utf8');
  assert.doesNotMatch(source, /function\s+decide\s*\(/);
  assert.doesNotMatch(source, /WEIGHTS\s*=\s*Object\.freeze\(\s*\{\s*need\s*:/);
  assert.match(source, /computeCanonicalMatchDecision/);
});

test('weights facade is frozen and points at the canonical matcher', () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.equal(WEIGHTS.canonical_match_engine, 100);
  assert.throws(() => { WEIGHTS.canonical_match_engine = 999; }, TypeError);
});

// ── 2026-07-05 QA regression: opportunity-side entity expansion is RESTRICTIVE ──
// The profile-side map "veteran → [veteran, individual]" was reused on the
// OPPORTUNITY side, so a military-only directory (DOL TAP, Boots to Business)
// allowed ANY individual and ACCEPTed at 75 for an 18-year-old non-military
// student. Military applicant buckets must collapse to the 'veteran' entity
// class so the canonical requiresVeteran gate can fire.

test('a military-only directory REJECTS for a non-military student thesis', () => {
  const studentThesis = buildThesis({
    id: 'p-student',
    primary_type: 'student',
    school: 'Cleveland State Community College',
    state: 'TN', city: 'Cleveland', county: 'Bradley',
    zip: '37312',
    needs: ['tuition'],
  });
  const dolTap = makeOpportunity({
    source_id: 'dol_tap', kind: OPPORTUNITY_KIND.DIRECTORY,
    title: 'Transition Assistance Program employment resources',
    sponsor: 'U.S. Department of Labor',
    summary: 'Official DOL VETS transition employment resource for separating and transitioning service members, veterans, and military spouses.',
    applicant_types: ['transitioning_service_member', 'active_duty', 'veteran', 'military_spouse'],
    need_categories: ['military_transition', 'employment'],
    geography: { national: true },
    apply_url: 'https://www.dol.gov/agencies/vets/programs/tap',
    trust_tier: TRUST_TIER.OFFICIAL_HTML, reality_status: REALITY_STATUS.VERIFIED,
  });
  const m = computeMatchDecision(dolTap, studentThesis);
  assert.equal(m.decision, MATCH_DECISION.REJECT, `military-only must REJECT for a non-military student (got ${m.decision} @ ${m.match_score})`);
});

test('the same military-only directory stays available to a veteran thesis', () => {
  const veteranThesis = buildThesis({
    id: 'p-vet',
    primary_type: 'individual',
    state: 'TN', city: 'Cleveland',
    zip: '37312',
    needs: ['employment'],
    // Declared military service — the thesis builder maps this to the veteran bucket.
    sections: [{ section_key: 'military_service', data: { is_veteran: true } }],
  });
  assert.ok(veteranThesis.applicant_types.includes('veteran'), 'thesis derives the veteran bucket');
  const dolTap = makeOpportunity({
    source_id: 'dol_tap', kind: OPPORTUNITY_KIND.DIRECTORY,
    title: 'Transition Assistance Program employment resources',
    sponsor: 'U.S. Department of Labor',
    summary: 'Official DOL VETS transition employment resource for separating and transitioning service members, veterans, and military spouses.',
    applicant_types: ['transitioning_service_member', 'active_duty', 'veteran', 'military_spouse'],
    need_categories: ['military_transition', 'employment'],
    geography: { national: true },
    apply_url: 'https://www.dol.gov/agencies/vets/programs/tap',
    trust_tier: TRUST_TIER.OFFICIAL_HTML, reality_status: REALITY_STATUS.VERIFIED,
  });
  const m = computeMatchDecision(dolTap, veteranThesis);
  assert.notEqual(m.decision, MATCH_DECISION.REJECT, `veteran profile must keep military resources (got ${m.decision} @ ${m.match_score})`);
});
