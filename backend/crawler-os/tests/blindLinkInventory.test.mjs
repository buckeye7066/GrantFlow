// tests/blindLinkInventory.test.mjs
//
// Phase 1a — the profile-blind LINK INVENTORY builder. These pin: correct
// extraction from anchors AND form actions, tracking-param stripping with
// identity-param preservation, deterministic document-ordering, boundedness,
// and the inventory-membership resolver that rejects hallucinated URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkInventory, resolveInventoryLink, canonicalizeUrl } from '../blindLinkInventory.js';

const BASE = 'https://funder.example.org/programs/';

test('extracts absolute links from anchors and resolves relative hrefs against baseUrl', () => {
  const html = `
    <main>
      <a href="https://other.example.com/apply">Apply Now</a>
      <a href="/details/123">Program details</a>
      <a href="mailto:info@x.org">email</a>
      <a href="#top">skip</a>
      <a href="javascript:void(0)">js</a>
    </main>`;
  const inv = buildLinkInventory(html, { baseUrl: BASE });
  const urls = inv.map((l) => l.url);
  assert.ok(urls.includes('https://other.example.com/apply'));
  assert.ok(urls.includes('https://funder.example.org/details/123'));
  // mailto/js/fragment-only are NOT absolute http(s) links.
  assert.ok(!urls.some((u) => u.startsWith('mailto:')));
  assert.ok(!urls.some((u) => u.includes('javascript')));
  assert.equal(inv.length, 2);
});

test('strips tracking params but KEEPS identity-bearing params', () => {
  const html = `
    <a href="https://f.org/grant?id=987&utm_source=news&utm_medium=email&fbclid=XYZ&gclid=abc">Grant 987</a>
    <a href="https://f.org/x?award=A1&ref=twitter&mc_cid=9">Award A1</a>`;
  const inv = buildLinkInventory(html, { baseUrl: BASE });
  const g = inv.find((l) => l.url.includes('/grant'));
  assert.ok(g.url.includes('id=987'), 'identity param id kept');
  assert.ok(!/utm_|fbclid|gclid/.test(g.url), 'tracking params stripped');
  const a = inv.find((l) => l.url.includes('/x'));
  assert.ok(a.url.includes('award=A1'), 'identity param award kept');
  assert.ok(!/ref=|mc_cid/.test(a.url), 'ref/mc_cid stripped');
});

test('captures an inline FORM action and its submit label', () => {
  const html = `
    <form action="/submit-application" method="post">
      <input type="text" name="name">
      <button type="submit">Start your application</button>
    </form>`;
  const inv = buildLinkInventory(html, { baseUrl: BASE });
  const form = inv.find((l) => l.source === 'form');
  assert.ok(form, 'form action captured');
  assert.equal(form.url, 'https://funder.example.org/submit-application');
  assert.equal(form.text, 'Start your application');
  assert.equal(form.apply_intent, true, 'submit/application label => apply intent');
});

test('deterministic: same html => byte-identical inventory (document order)', () => {
  const html = `
    <a href="https://f.org/a">Alpha</a>
    <form action="https://f.org/form"><button type="submit">Apply</button></form>
    <a href="https://f.org/b">Beta</a>`;
  const a = buildLinkInventory(html, { baseUrl: BASE });
  const b = buildLinkInventory(html, { baseUrl: BASE });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // ids are 1..N in document order; the form sits between the two anchors.
  assert.deepEqual(a.map((l) => [l.id, l.url]), [
    ['L1', 'https://f.org/a'],
    ['L2', 'https://f.org/form'],
    ['L3', 'https://f.org/b'],
  ]);
});

test('apply_intent is a keyword signal, not a profile signal', () => {
  const html = `
    <a href="https://f.org/apply-here">Apply here</a>
    <a href="https://f.org/about">About the foundation</a>`;
  const inv = buildLinkInventory(html, { baseUrl: BASE });
  assert.equal(inv.find((l) => l.url.endsWith('/apply-here')).apply_intent, true);
  assert.equal(inv.find((l) => l.url.endsWith('/about')).apply_intent, false);
});

test('bounded: never exceeds the max cap', () => {
  const many = Array.from({ length: 50 }, (_, i) => `<a href="https://f.org/p${i}">P${i}</a>`).join('');
  const inv = buildLinkInventory(many, { baseUrl: BASE, max: 10 });
  assert.equal(inv.length, 10);
  assert.deepEqual(inv.map((l) => l.id).slice(0, 3), ['L1', 'L2', 'L3']);
});

test('dedupes the same canonical URL, merging apply intent, keeping first position', () => {
  const html = `
    <a href="https://f.org/g?id=1&utm_source=a">Details</a>
    <a href="https://f.org/g?id=1&utm_source=b">Apply now</a>`;
  const inv = buildLinkInventory(html, { baseUrl: BASE });
  assert.equal(inv.length, 1, 'same identity URL collapses to one entry');
  assert.equal(inv[0].apply_intent, true, 'apply intent merged from the later duplicate');
});

test('resolveInventoryLink: by id, by url, and REJECTS a non-inventory url', () => {
  const inv = buildLinkInventory('<a href="https://f.org/real">R</a>', { baseUrl: BASE });
  assert.equal(resolveInventoryLink(inv, 'L1').url, 'https://f.org/real');
  // by url with tracking noise still resolves (same canonical identity)
  assert.equal(resolveInventoryLink(inv, 'https://f.org/real?utm_source=x').url, 'https://f.org/real');
  // a URL that is NOT on the page resolves to null (rejected)
  assert.equal(resolveInventoryLink(inv, 'https://evil.example/hallucinated'), null);
  assert.equal(resolveInventoryLink(inv, 'L99'), null);
});

test('malformed / empty input never throws', () => {
  assert.deepEqual(buildLinkInventory(''), []);
  assert.deepEqual(buildLinkInventory(null), []);
  assert.deepEqual(buildLinkInventory(12345), []);
  assert.equal(canonicalizeUrl('not a url'), null);
});
