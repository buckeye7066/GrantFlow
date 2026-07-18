// crawler-os/blindLinkInventory.js
//
// Phase 1a of the web-lane de-contamination program: the LINK INVENTORY builder.
//
// A page's links are the ONLY thing that can ground an "apply here" / "more
// info" URL. The current profile-conditioned extractor lets the LLM emit a URL
// as free text (which it can hallucinate) and falls back to the page URL. The
// profile-blind path instead hands the model a bounded, deterministic inventory
// of the links that ACTUALLY EXIST on the page — each with a stable id — and
// makes the model SELECT one by id. Code then constructs the real URL from the
// inventory and rejects anything the model invents.
//
// PURE. No I/O, no network, no profile input. Given the same html (+ baseUrl)
// this returns a byte-identical inventory — ordering is DOCUMENT ORDER only,
// never any notion of profile fit (there is no profile here).

import * as cheerio from 'cheerio';

// Query-string parameters that carry NO identity — only tracking/analytics.
// Stripped so the same real link with different campaign tags collapses to one
// canonical URL. Identity-bearing params (?id=, ?award=, ?oppId=, …) are KEPT.
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'wbraid', 'gbraid', 'msclkid', 'yclid',
  'mc_eid', 'mc_cid', 'igshid', 'ref_src', 'ref_url', 'ref', 'referrer',
  '_hsenc', '_hsmi', 'vero_id', 'vero_conv', '_openstat', 'oly_anon_id',
  'oly_enc_id', 'spm', 'scm', 's_cid', 'cmpid', 'campaign_id',
]);
// Prefix families (delete any param whose lowercased name starts with one).
const TRACKING_PREFIXES = ['utm_', 'pk_', 'piwik_', 'matomo_', 'hsa_', 'mtm_'];

function isTrackingParam(name) {
  const n = String(name).toLowerCase();
  if (TRACKING_EXACT.has(n)) return true;
  return TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

// Anchor/label/URL tokens that signal an application-INTENT link (as opposed to
// a general info/detail link). Deterministic keyword set — NOT profile-derived.
const APPLY_INTENT = /\b(apply|application|applications|submit|register|registration|enroll|start\s+application|begin\s+application|rfp|rfa|nofo|request\s+for\s+(proposals?|applications?)|how\s+to\s+apply)\b/i;

/**
 * Strip tracking params from a URL string while preserving identity params and a
 * stable ordering. Returns a canonicalized absolute http(s) URL string, or null
 * if the input is not a resolvable absolute http(s) URL.
 */
function canonicalizeUrl(raw, baseUrl) {
  let u;
  try {
    u = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Drop tracking params, preserve the rest in their existing order.
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (isTrackingParam(k)) continue;
    kept.push([k, v]);
  }
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  // Drop a pure fragment (never identity-bearing for an application target).
  u.hash = '';
  return u.toString();
}

function squash(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * buildLinkInventory — extract a bounded, deterministic inventory of a page's
 * absolute links from anchors AND form actions.
 *
 * @param {string} html raw page HTML.
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] page URL used to resolve relative hrefs/actions
 *   (also honored: a `<base href>` in the document). Links that cannot be made
 *   absolute http(s) are dropped (an inventory of ABSOLUTE links, by contract).
 * @param {number} [opts.max=200] hard cap on inventory size (bounded).
 * @returns {Array<{id:string, url:string, text:string, context:string,
 *   source:'anchor'|'form', apply_intent:boolean}>} document-ordered, deduped.
 */
export function buildLinkInventory(html, opts = {}) {
  if (!html || typeof html !== 'string') return [];
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 200;
  let $;
  try { $ = cheerio.load(html); } catch { return []; }

  // Resolve base: explicit opt wins, else a document <base href>, else none.
  let baseUrl = opts.baseUrl ? String(opts.baseUrl) : '';
  const baseHref = $('base[href]').first().attr('href');
  if (!baseUrl && baseHref) baseUrl = String(baseHref);

  // Walk anchors and form actions in ONE document-ordered pass (a combined CSS
  // selector yields elements in document order), so ids are position-stable and
  // reflect nothing but where the link sits on the page.
  const byUrl = new Map(); // canonical url -> entry (first occurrence wins position)
  const order = [];

  $('a[href], form[action]').each((_i, el) => {
    if (order.length >= max) return false; // stop — bounded
    const $el = $(el);
    const isForm = el.tagName === 'form' || el.name === 'form';
    const raw = isForm ? $el.attr('action') : $el.attr('href');
    // Skip empty and pure same-page fragment anchors (#top): they are navigation,
    // not a real link target — resolving them would collapse onto the page URL.
    if (!raw || (!isForm && /^\s*#/.test(raw))) return undefined;
    const url = canonicalizeUrl(raw, baseUrl);
    if (!url) return undefined;

    // Label/anchor text + a bounded surrounding context.
    let text;
    if (isForm) {
      text = squash(
        $el.attr('aria-label') ||
          $el.find('button[type="submit"], input[type="submit"]').first().attr('value') ||
          $el.find('button[type="submit"]').first().text() ||
          $el.attr('name') ||
          '',
      );
    } else {
      text = squash($el.attr('aria-label') || $el.text() || $el.attr('title') || '');
    }
    const context = squash($el.closest('li, p, td, section, article, div').first().text(), 200);
    const applyIntent =
      APPLY_INTENT.test(text) || APPLY_INTENT.test(context) || APPLY_INTENT.test(url);

    const existing = byUrl.get(url);
    if (existing) {
      // Same real link seen twice: keep first position, OR the intent signals so
      // an "Apply" duplicate is never demoted by an earlier "Details" anchor.
      if (applyIntent) existing.apply_intent = true;
      return undefined;
    }
    const entry = {
      id: '', // assigned after the pass so ids are 1..N in document order
      url,
      text,
      context,
      source: isForm ? 'form' : 'anchor',
      apply_intent: applyIntent,
    };
    byUrl.set(url, entry);
    order.push(entry);
    return undefined;
  });

  order.forEach((entry, i) => { entry.id = `L${i + 1}`; });
  return order;
}

/**
 * Look up an inventory entry by id OR by (canonicalized) url. Returns the entry
 * or null. This is the ONLY sanctioned way to turn a model's link choice into a
 * real URL — a url the model returns that is not in the inventory resolves to
 * null (rejected), which is what stops URL hallucination.
 */
export function resolveInventoryLink(inventory, ref, baseUrl) {
  if (!Array.isArray(inventory) || ref == null) return null;
  const s = String(ref).trim();
  if (!s) return null;
  // By id (exact, case-insensitive on the L-prefix).
  const byId = inventory.find((e) => e && String(e.id).toLowerCase() === s.toLowerCase());
  if (byId) return byId;
  // By url — canonicalize the model's string the SAME way so tracking-param or
  // trailing-slash noise can't cause a spurious miss, then require membership.
  const canon = canonicalizeUrl(s, baseUrl);
  if (!canon) return null;
  return inventory.find((e) => e && e.url === canon) || null;
}

export { canonicalizeUrl };
export default { buildLinkInventory, resolveInventoryLink, canonicalizeUrl };
