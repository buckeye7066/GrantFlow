// crawler-os/urlCanonical.js
//
// Pure URL canonicalization shared across the crawler-os lanes. Extracted from
// blindLinkInventory.js so NON-blind live code (e.g. webLane's target-verify
// dedup) can reuse the EXACT same normalization without importing a blind
// extraction module (see backend/tests/blindExtractorNotWired.test.js — the live
// scoring path must stay blind-import-free). blindLinkInventory re-exports
// `canonicalizeUrl` from here, so its own consumers are unchanged.
//
// PURE. No I/O, no profile input. Given the same input it returns the same output.

// KNOWN tracking/analytics parameters — an explicit ALLOWLIST-TO-STRIP. Only
// these are removed; EVERYTHING else (incl. ?ref=, ?campaign_id=, ?source=, and
// any unknown param) is PRESERVED, because it may distinguish two real links.
// Over-stripping is a security bug in the link-inventory context: if two distinct
// inventory links collapse to one identity, a model can smuggle a non-inventory
// URL past the membership check (?ref=grant-A vs ?ref=grant-B must stay DISTINCT).
const TRACKING_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'wbraid', 'gbraid', 'msclkid', 'yclid',
  'mc_eid', 'mc_cid', 'igshid', 'mkt_tok', '_hsenc', '_hsmi', 'vero_id',
  'vero_conv', '_openstat', 'oly_anon_id', 'oly_enc_id', '_ga', '_gl',
]);
// Prefix families (delete any param whose lowercased name starts with one).
// utm_* is the only broadly-safe prefix family; the rest are vendor analytics.
const TRACKING_PREFIXES = ['utm_', 'pk_', 'piwik_', 'matomo_', 'mtm_', 'hsa_'];

function isTrackingParam(name) {
  const n = String(name).toLowerCase();
  if (TRACKING_EXACT.has(n)) return true;
  return TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * Canonicalize a URL to its FULL SEMANTIC IDENTITY: strip ONLY known tracking
 * params, and PRESERVE every identity-bearing part — remaining query params
 * (order preserved) AND the fragment (a hash can carry SPA route identity, e.g.
 * `app#/grant-A` vs `app#/grant-B`). Returns an absolute http(s) URL string, or
 * null if the input is not a resolvable absolute http(s) URL (scheme sanitized:
 * javascript:/data:/mailto:/tel:/etc. all return null).
 */
function canonicalizeUrl(raw, baseUrl) {
  let u;
  try {
    u = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Drop ONLY known tracking params; preserve everything else in existing order.
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (isTrackingParam(k)) continue;
    kept.push([k, v]);
  }
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  // Fragment is PRESERVED — it can distinguish two real SPA/section links, and
  // dropping it would let a model's non-inventory URL collapse onto an entry.
  return u.toString();
}

export { isTrackingParam, canonicalizeUrl };
export default { isTrackingParam, canonicalizeUrl };
