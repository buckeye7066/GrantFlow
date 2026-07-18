// tests/blindOpportunityKind.test.mjs
//
// Phase 1c — the PURE, trust-aware AGGREGATOR/DIRECTORY classifier. These pin:
// a multi-program list => AGGREGATOR_INDEX, a single real program => DIRECT_PROGRAM,
// a sparse page => UNKNOWN; the PROTECTED bar (named operator + verified info
// target + trusted signal) vs an open-web list => UNVERIFIED; determinism; and
// profile-blindness (the signature reads ONLY page-derived inputs).
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

// Build an inventory of N distinct http(s) links on a host, each optionally
// resolvable. Mirrors buildLinkInventory's { id, url, text } shape.
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

test('a concrete apply target settles DIRECT_PROGRAM even when the page mentions other grants', () => {
  const candidate = {
    title: 'STEM Scholarship',
    sponsor: 'Acme Foundation',
    apply_url: 'https://acme.org/stem/apply',
    info_url: 'https://acme.org/stem',
  };
  const linkInventory = [
    { id: 'L1', url: 'https://acme.org/stem/apply', text: 'Apply' },
    ...inv(15, 'https://acme.org'), // many links AND directory language present...
  ];
  const pageText = `Browse grants and find scholarships. Search our database. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  // ...but a resolved concrete apply link blocks the aggregator path.
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.DIRECT_PROGRAM);
});

test('a pure link-farm with NO directory language but a very high link count => AGGREGATOR_INDEX', () => {
  const candidate = { title: 'Resources', sponsor: 'Portal', apply_url: null, info_url: null };
  const out = classifyBlindOpportunityKind({ candidate, linkInventory: inv(35), pageText: LONG });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.ok(out.signals.link_farm);
});

test('PROTECTED requires named operator + verified info target + trusted signal', () => {
  // A durable directory: named operator, an info target that is a REAL inventory
  // link, on a trusted (.gov) host.
  const infoUrl = 'https://benefits.gov/browse';
  const linkInventory = [{ id: 'L1', url: infoUrl, text: 'Browse benefits' }, ...inv(15)];
  const candidate = { title: 'Benefits Finder', sponsor: 'US Government', apply_url: null, info_url: infoUrl };
  const pageText = `Browse grants and search our database of benefits. Directory of programs. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.PROTECTED);
  assert.equal(out.signals.trusted_host, true);
});

test('an open-web list (no trusted host) => AGGREGATOR_INDEX but UNVERIFIED (no protection)', () => {
  const infoUrl = 'https://someblog.example.com/grants';
  const linkInventory = [{ id: 'L1', url: infoUrl, text: 'See the list' }, ...inv(15, 'https://someblog.example.com')];
  const candidate = { title: 'Grant List', sponsor: 'Some Blog', apply_url: null, info_url: infoUrl };
  const pageText = `Browse grants and search for grants. List of grants. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED); // trusted-host bar not met
});

test('a directory whose info target is only the page-URL fallback (NOT an inventory member) is never PROTECTED', () => {
  // info_url points at a gov host, but that url is NOT one of the page's real
  // links (not in the inventory) — so there is no VERIFIED info target.
  const linkInventory = inv(15, 'https://random.example.com'); // gov url absent here
  const candidate = { title: 'Finder', sponsor: 'Agency', apply_url: null, info_url: 'https://benefits.gov/x' };
  const pageText = `Browse grants and search our database. Directory of funding. ${LONG}`;
  const out = classifyBlindOpportunityKind({ candidate, linkInventory, pageText });
  assert.equal(out.kind, BLIND_OPPORTUNITY_KIND.AGGREGATOR_INDEX);
  assert.equal(out.trust, BLIND_TRUST.UNVERIFIED);
  assert.equal(out.signals.has_verified_info_target, false);
});

test('deterministic: identical inputs => identical output', () => {
  const candidate = { title: 'Grants Directory', sponsor: 'Hub', apply_url: null, info_url: null };
  const args = { candidate, linkInventory: inv(20), pageText: `Browse grants. List of grants. ${LONG}` };
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

test('robust to garbage input: never throws, defaults to UNKNOWN/UNVERIFIED', () => {
  for (const bad of [undefined, null, {}, { candidate: null, linkInventory: 'x', pageText: 42 }]) {
    const out = classifyBlindOpportunityKind(bad);
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
