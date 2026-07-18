// tests/blindOpportunityKind.test.mjs
//
// Phase 1c — the PURE, trust-aware AGGREGATOR/DIRECTORY classifier. These pin:
// a multi-program list => AGGREGATOR_INDEX, a single real program => DIRECT_PROGRAM,
// a sparse page => UNKNOWN; the PROTECTED bar (named operator + TRUSTED OPERATOR
// PAGE HOST + verified info target) vs an open-web list => UNVERIFIED; the
// aggregator-vs-direct edge cases (a directory containing one apply link; a
// nav-heavy single-program page); determinism; profile-blindness; and total
// no-throw robustness on hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBlindOpportunityKind,
  emptyKindBreakdown,
  accumulateKindBreakdown,
  BLIND_OPPORTUNITY_KIND,
  BLIND_TRUST,
  AGGREGATOR_MIN_LINKS,
} from '../blindOpportunityKind.js';

// Build an inventory of N distinct http(s) links on a host. Mirrors
// buildLinkInventory's { id, url, text } shape.
function inv(n, host = 'https://directory.example.org') {
  return Array.from({ length: n }, (_, i) => ({
    id: `L${i + 1}`,
    url: `${host}/program/${i + 1}`,
    text: `Program ${i + 1}`,
    source: 'anchor',
    apply_intent: false,
  }));
}

const LONG = 'x '.repeat(200); // >> MIN_PAGE_TEXT_CHARS of filler

test('a multi-program list/directory page => AGGREGATOR_INDEX', () => {
  const candidate = { title: 'Grants Directory', sponsor: 'Community Resource Hub', apply_url: null, info_url: null };
  const pageText = `Browse grants and search our database. List of grants below. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory: inv(20), pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.ok(out.signals.directory_cue_count >= 1);
  assert.ok(out.signals.link_count >= AGGREGATOR_MIN_LINKS);
});

test('a single real program page => DIRECT_PROGRAM', () => {
  const candidate = {
    title: 'Nashville Youth Services Grant',
    sponsor: 'Nashville Community Foundation',
    apply_url: 'https://nyf.org/grant/apply',
    info_url: 'https://nyf.org/grant',
  };
  const linkInventory = [
    { id: 'L1', url: 'https://nyf.org/grant/apply', text: 'Apply here', apply_intent: true },
    { id: 'L2', url: 'https://nyf.org/', text: 'Home' },
    { id: 'L3', url: 'https://nyf.org/contact', text: 'Contact' },
  ];
  const pageText = `The Nashville Community Foundation offers the Nashville Youth Services Grant to nonprofits serving youth in Tennessee. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED); // a program is never a "protected locator"
});

test('a sparse page => UNKNOWN', () => {
  const candidate = { title: 'Something', sponsor: 'Someone', apply_url: null, info_url: null };
  const out = classifyBlindOpportunityKind({ candidate, linkInventory: [], pageText: 'tiny' });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.UNKNOWN);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED);
});

test('a DIRECT program page with an apply link and a WEAK (not strong) directory signal stays DIRECT_PROGRAM', () => {
  const candidate = {
    title: 'STEM Scholarship',
    sponsor: 'Acme Foundation',
    apply_url: 'https://acme.org/stem/apply',
    info_url: 'https://acme.org/stem',
  };
  const linkInventory = [
    { id: 'L1', url: 'https://acme.org/stem/apply', text: 'Apply' },
    { id: 'L2', url: 'https://acme.org/', text: 'Home' },
    { id: 'L3', url: 'https://acme.org/about', text: 'About' },
  ];
  // Mentions "find scholarships" (one cue) but few links → not a strong list.
  const pageText = `The Acme Foundation STEM Scholarship. You can also find scholarships elsewhere. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM);
});

test('finding 3a: a STRONG directory (many links + strong cues) that contains ONE apply link stays AGGREGATOR_INDEX', () => {
  const candidate = {
    title: 'Grants & Scholarships',
    sponsor: 'Resource Center',
    apply_url: 'https://directory.example.org/program/1/apply', // one apply link on a directory
    info_url: null,
  };
  const linkInventory = [
    { id: 'A', url: 'https://directory.example.org/program/1/apply', text: 'Apply', apply_intent: true },
    ...inv(20), // 20 more distinct program links
  ];
  const pageText = `Browse grants and search our database. List of grants and directory of funding below. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  // A directory can contain apply links — the strong list signal must win.
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.signals.strong_aggregator, true);
});

test('finding 3b: a single-program .edu page with ~35 NAVIGATION links (no apply, no directory cues) stays DIRECT_PROGRAM', () => {
  const infoUrl = 'https://university.edu/scholarships/marshall/details';
  const candidate = {
    title: 'Marshall Scholarship',
    sponsor: 'State University',
    page_url: 'https://university.edu/scholarships/marshall',
    apply_url: null,
    info_url: infoUrl,
  };
  // 35 ordinary navigation anchors + the one real info link. NO directory cues.
  const linkInventory = [{ id: 'INFO', url: infoUrl, text: 'Program details' }, ...inv(35, 'https://university.edu')];
  const pageText = `State University offers the Marshall Scholarship to graduating seniors. Eligibility and program details follow. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  // Raw anchor count is NOT aggregator evidence without directory language.
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM);
  assert.equal(out.signals.single_program_signal, true);
});

test('finding 3b (corollary): many nav links + NO directory cues + no program signal => UNKNOWN, never AGGREGATOR', () => {
  const candidate = { title: '', sponsor: 'X', apply_url: null, info_url: null };
  const out = classifyBlindOpportunityKind({ candidate, linkInventory: inv(40), pageText: LONG });
  assert.notEqual(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.UNKNOWN);
});

test('PROTECTED requires named operator + TRUSTED OPERATOR PAGE HOST + verified info target', () => {
  // A durable directory: named operator, its OWN page host is .gov, and the info
  // target is a REAL inventory link.
  const infoUrl = 'https://benefits.gov/browse/list';
  const linkInventory = [{ id: 'L1', url: infoUrl, text: 'Browse benefits' }, ...inv(15)];
  const candidate = {
    title: 'Benefits Finder',
    sponsor: 'US Government',
    page_url: 'https://benefits.gov/browse',
    apply_url: null,
    info_url: infoUrl,
  };
  const pageText = `Browse grants and search our database of benefits. Directory of programs. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.PROTECTED);
  assert.equal(out.signals.operator_host_trusted, true);
});

test('finding 2: a blog that merely LINKS to benefits.gov is NOT a trusted operator => UNVERIFIED', () => {
  // The operator page host is a blog; it selects an inventory-member benefits.gov
  // link as its info target. Trust must reflect the OPERATOR, not the linked host.
  const infoUrl = 'https://benefits.gov/list';
  const linkInventory = [
    { id: 'L1', url: infoUrl, text: 'See the official list' },
    ...inv(15, 'https://someblog.example.com'),
  ];
  const candidate = {
    title: 'Best Grants 2026',
    sponsor: 'Some Blog',
    page_url: 'https://someblog.example.com/grants',
    apply_url: null,
    info_url: infoUrl,
  };
  const pageText = `Browse grants and search for grants. List of grants and directory of funding. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED); // operator host untrusted, despite the .gov link
  assert.equal(out.signals.operator_host_trusted, false);
});

test('an open-web list with an untrusted operator host => AGGREGATOR_INDEX but UNVERIFIED', () => {
  const infoUrl = 'https://someblog.example.com/grants/list';
  const linkInventory = [{ id: 'L1', url: infoUrl, text: 'See the list' }, ...inv(15, 'https://someblog.example.com')];
  const candidate = {
    title: 'Grant List',
    sponsor: 'Some Blog',
    page_url: 'https://someblog.example.com/grants',
    apply_url: null,
    info_url: infoUrl,
  };
  const pageText = `Browse grants and search for grants. List of grants. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED);
});

test('a durable-host directory whose info target is NOT an inventory member is never PROTECTED', () => {
  // Operator host is .gov, but the info_url is not one of the page's real links
  // (not in the inventory) — so there is no VERIFIED info target.
  const linkInventory = inv(15, 'https://benefits.gov'); // the info url below is absent here
  const candidate = {
    title: 'Finder',
    sponsor: 'Agency',
    page_url: 'https://benefits.gov/finder',
    apply_url: null,
    info_url: 'https://benefits.gov/somewhere-else',
  };
  const pageText = `Browse grants and search our database. Directory of funding. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED);
  assert.equal(out.signals.has_verified_info_target, false);
});

test('deterministic: identical inputs => identical output', () => {
  const candidate = { title: 'Grants Directory', sponsor: 'Hub', page_url: 'https://x.org', apply_url: null, info_url: null };
  const args = { candidate, linkInventory: inv(20), pageText: `Browse grants. List of grants. Directory of funding. ${LONG}` };
  const a = classifyBlindOpportunityKind(args);
  const b = classifyBlindOpportunityKind(args);
  assert.deepEqual(a, b);
});

test('profile-blind: extra profile-shaped fields on the input are IGNORED (no behavior change)', () => {
  const candidate = {
    title: 'Nashville Youth Services Grant',
    sponsor: 'Nashville Community Foundation',
    apply_url: 'https://nyf.org/grant/apply',
    info_url: 'https://nyf.org/grant',
  };
  const linkInventory = [{ id: 'L1', url: 'https://nyf.org/grant/apply', text: 'Apply' }];
  const pageText = `The Nashville Community Foundation offers a youth grant. ${LONG}`;
  const base = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  // Inject a profile / thesis / query — the classifier must not read any of them.
  const withProfile = classifyBlindOpportunityKind({
    candidate, linkInventory, pageText,
    profile: { applicant_types: ['nonprofit'], location: { state: 'TN' }, needs: ['youth'] },
    thesis: { applicant_types: ['nonprofit'] },
    query: 'youth grants tennessee',
  });
  assert.deepEqual(withProfile, base);
});

test('finding 1: NEVER throws on hostile input — null-prototype pageText, throwing getters, non-array inventory, null candidate', () => {
  const nullProtoText = Object.create(null); // String(this) throws
  const throwingUrlInv = [{ id: 'L1', get url() { throw new Error('hostile getter'); } }];
  const throwingCandidate = {
    get sponsor() { throw new Error('hostile'); },
    get apply_url() { throw new Error('hostile'); },
  };
  const cases = [
    undefined,
    null,
    {},
    { candidate: null, linkInventory: 'not-an-array', pageText: 42 },
    { candidate: { sponsor: 'X' }, linkInventory: [], pageText: nullProtoText },
    { candidate: { sponsor: 'X', apply_url: null }, linkInventory: throwingUrlInv, pageText: 'Browse grants list of grants directory of funding' },
    { candidate: throwingCandidate, linkInventory: [], pageText: 'x' },
    { get candidate() { throw new Error('hostile input getter'); } },
  ];
  for (const bad of cases) {
    let out;
    assert.doesNotThrow(() => { out = classifyBlindOpportunityKind(bad); });
    assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.UNKNOWN);
    assert.equal(out.trust, BLIND_TRUST.UNVERIFIED);
  }
});

test('accumulateKindBreakdown: the trust split covers exactly the aggregator bucket', () => {
  const b = emptyKindBreakdown();
  accumulateKindBreakdown(b, { kind: BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM, trust: BLIND_TRUST.UNVERIFIED });
  accumulateKindBreakdown(b, { kind: BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX, trust: BLIND_TRUST.PROTECTED });
  accumulateKindBreakdown(b, { kind: BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX, trust: BLIND_TRUST.UNVERIFIED });
  accumulateKindBreakdown(b, { kind: BLIND_OPPORTUNITY_KIND.UNKNOWN, trust: BLIND_TRUST.UNVERIFIED });
  assert.deepEqual(b, { direct: 1, aggregator_index: 2, unknown: 1, protected_directory: 1, unverified_index: 1 });
  assert.equal(b.protected_directory + b.unverified_index, b.aggregator_index);
});
