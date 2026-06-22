// crawler-os/safeUrl.js
//
// THE single canonical URL validator for Crawler OS. Every fetch, every stored
// apply_url, every redirect target passes through here. SSRF defense + honesty
// defense (no search-engine URL masquerading as a direct application link).
//
// Pure, no I/O. DNS is NOT resolved here; the fetcher additionally validates each
// redirect hop's literal host AND (with an injected resolver) the resolved IPs to
// defend against DNS rebinding.

import net from 'node:net';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,                 // 127.0.0.0/8 loopback
  /^10\./,                  // 10.0.0.0/8 RFC1918
  /^192\.168\./,            // 192.168.0.0/16
  /^169\.254\./,            // link-local / cloud metadata 169.254.169.254
  /^::1$/,                  // IPv6 loopback
  /^fe80:/i,                // IPv6 link-local
  /^fc00:/i, /^fd00:/i,     // IPv6 ULA
  /\.local$/i,
  /\.internal$/i,
];

// 172.16.0.0 – 172.31.255.255
function isPrivate172(host) {
  const m = /^172\.(\d+)\./.exec(host);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 16 && second <= 31;
}

// Search-engine / aggregator *result* URLs that must never be stored as an
// "apply here" link. (The directory/locator KIND is fine; a search query URL
// presented as a direct application is dishonest.)
const SEARCH_URL_HOSTS = [
  /(^|\.)google\.[a-z.]+$/i,
  /(^|\.)bing\.com$/i,
  /(^|\.)duckduckgo\.com$/i,
  /(^|\.)search\.yahoo\.com$/i,
  /(^|\.)baidu\.com$/i,
];
const SEARCH_URL_PATHS = [/^\/search/i, /^\/url$/i];

export function isPrivateHost(host) {
  if (!host) return true;
  const h = normalizeHost(host);
  if (!h) return true;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(h))) return true;
  if (isPrivate172(h)) return true;
  if (isBlockedIpLiteral(h)) return true;
  return false;
}

function normalizeHost(host) {
  let h = String(host ?? '').trim().toLowerCase();
  // WHATWG URL.hostname returns IPv6 literals with brackets in Node. Strip them
  // before testing, otherwise http://[::1]/ and http://[fd00::1]/ slip past the
  // canonical validator even though they are private/link-local addresses.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isBlockedIpLiteral(host) {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) return false; // IPv4 private ranges are handled by regex above.
  if (ipVersion !== 6) return false;
  if (host === '::' || host === '::1') return true; // unspecified, loopback
  // IPv4-mapped IPv6 literals normalize to hex in WHATWG URL parsing (for
  // example ::ffff:127.0.0.1 -> ::ffff:7f00:1). Block all mapped literals;
  // legitimate public IPv4 hosts should be expressed in IPv4 form.
  if (host.startsWith('::ffff:')) return true;
  // Range checks on the first hextet. startsWith('fe80:') previously missed the
  // rest of link-local space (fe80::/10 spans fe80-febf, e.g. fe90::1, febf::1),
  // so a hostile fetch URL could slip past the canonical validator. Mask the top
  // bits instead so the whole reserved block is blocked precisely.
  const head = parseInt(host.split(':')[0] || '0', 16);
  if (Number.isNaN(head)) return true;                 // unparseable -> refuse
  if ((head & 0xffc0) === 0xfe80) return true;         // fe80::/10 link-local (fe80-febf)
  if ((head & 0xfe00) === 0xfc00) return true;         // fc00::/7  unique-local (fc00-fdff)
  if ((head & 0xffc0) === 0xfec0) return true;         // fec0::/10 deprecated site-local
  return false;
}

function looksLikeSearchUrl(u) {
  if (SEARCH_URL_HOSTS.some((re) => re.test(u.hostname))) {
    if (SEARCH_URL_PATHS.some((re) => re.test(u.pathname))) return true;
    if (u.search && /[?&](q|query|p)=/.test(u.search)) return true;
  }
  return false;
}

/**
 * isSafeUrl — validate a URL string.
 *
 * @param {string} url
 * @param {{ kind?: 'apply'|'info'|'fetch' }} [opts]
 * @returns {{ ok:boolean, reason?:string, url?:string, host?:string }}
 */
export function isSafeUrl(url, opts = {}) {
  const kind = opts.kind ?? 'fetch';
  if (!url || typeof url !== 'string') return { ok: false, reason: 'empty' };
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `bad_protocol:${u.protocol}` };
  }
  // Production honesty: prefer https. http is allowed for fetch but flagged.
  if (u.protocol === 'http:' && kind === 'apply') {
    return { ok: false, reason: 'apply_url_not_https' };
  }
  if (!u.hostname || u.hostname.indexOf('.') === -1) {
    // bare hostnames (no dot) are suspicious except for explicit fetch testing
    if (kind !== 'fetch') return { ok: false, reason: 'no_tld' };
  }
  if (isPrivateHost(u.hostname)) {
    return { ok: false, reason: 'private_host' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'embedded_credentials' };
  }
  if ((kind === 'apply') && looksLikeSearchUrl(u)) {
    return { ok: false, reason: 'search_url_as_apply' };
  }
  return { ok: true, url: u.toString(), host: u.hostname };
}

export default { isSafeUrl, isPrivateHost };
