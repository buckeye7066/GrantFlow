// crawler-os/fetcher.js
//
// THE fetcher. SSRF-safe, rate-limited, evidence-capturing. Every URL passes
// safeUrl first; every redirect hop is re-validated against the literal host AND
// (when a resolver is injected) against the resolved IPs — closing the
// DNS-rebinding gap left as a TODO in the prior version.
//
// The actual network call is injected (`doFetch`) so the engine is fully testable
// offline and so the host app controls timeouts/proxies. In production pass the
// platform `fetch`.

import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { isSafeUrl, isPrivateHost } from './safeUrl.js';

const DEFAULT_RATE_MS = 250; // min gap between requests to the same host

function sha256(s) { return createHash('sha256').update(s ?? '').digest('hex'); }
function now() { return new Date().toISOString(); }

/**
 * createFetcher — build a fetcher bound to a network impl + optional DNS resolver.
 *
 * @param {object} opts
 * @param {(url:string, init?:object)=>Promise<{status:number, ok:boolean, text:()=>Promise<string>, url?:string, headers?:any}>} opts.doFetch
 * @param {(host:string)=>Promise<string[]>} [opts.resolve]  returns IPs for a host (DNS-rebinding guard)
 * @param {number} [opts.rateMs]
 * @param {number} [opts.maxRedirects]
 * @param {()=>number} [opts.clock]  ms clock (injectable for tests)
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 */
export function createFetcher(opts = {}) {
  const doFetch = opts.doFetch;
  if (typeof doFetch !== 'function') throw new Error('createFetcher: opts.doFetch is required');
  const resolve = typeof opts.resolve === 'function'
    ? opts.resolve
    : async (host) => {
        const records = await dns.promises.lookup(host, { all: true, verbatim: true })
        return records.map((record) => record.address)
      };
  const rateMs = Number.isFinite(opts.rateMs) ? opts.rateMs : DEFAULT_RATE_MS;
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : 4;
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const lastHitByHost = new Map();

  async function rateLimit(host) {
    const last = lastHitByHost.get(host) ?? 0;
    const wait = rateMs - (clock() - last);
    if (wait > 0) await sleep(wait);
    lastHitByHost.set(host, clock());
  }

  async function guardHostIps(host) {
    if (!resolve) return { ok: true };
    let ips = [];
    try { ips = await resolve(host); } catch (e) { return { ok: false, reason: `dns_error:${e?.code ?? e}` }; }
    if (!ips.length) return { ok: false, reason: 'dns_no_records' };
    if (ips.some((ip) => isPrivateHost(ip))) return { ok: false, reason: 'dns_resolves_private' };
    return { ok: true, ips };
  }

  /**
   * fetch — safe GET (or method) with evidence capture.
   * @returns {Promise<{ ok:boolean, status:number|null, finalUrl:string|null,
   *   contentHash:string|null, body:string|null, fetchedAt:string, error?:string,
   *   reason?:string, hops?:string[] }>}
   */
  async function fetchUrl(url, init = {}) {
    const first = isSafeUrl(url, { kind: 'fetch' });
    if (!first.ok) {
      return { ok: false, status: null, finalUrl: null, contentHash: null, body: null,
        fetchedAt: now(), error: 'unsafe_url', reason: first.reason };
    }
    let current = first.url;
    const hops = [current];
    for (let i = 0; i <= maxRedirects; i++) {
      const parsed = new URL(current);
      const ipGuard = await guardHostIps(parsed.hostname);
      if (!ipGuard.ok) {
        return { ok: false, status: null, finalUrl: current, contentHash: null, body: null,
          fetchedAt: now(), error: 'ssrf_guard', reason: ipGuard.reason, hops };
      }
      await rateLimit(parsed.hostname);
      let res;
      try {
        res = await doFetch(current, { ...init, redirect: 'manual' });
      } catch (e) {
        return { ok: false, status: null, finalUrl: current, contentHash: null, body: null,
          fetchedAt: now(), error: String(e?.message ?? e), reason: 'fetch_threw', hops };
      }
      const status = res.status ?? null;
      // Manual redirect handling so each hop is re-validated.
      if (status && status >= 300 && status < 400) {
        const loc = (res.headers?.get?.('location')) ?? res.location ?? null;
        if (!loc) {
          return { ok: false, status, finalUrl: current, contentHash: null, body: null,
            fetchedAt: now(), error: 'redirect_without_location', reason: 'bad_redirect', hops };
        }
        const next = new URL(loc, current).toString();
        const safe = isSafeUrl(next, { kind: 'fetch' });
        if (!safe.ok) {
          return { ok: false, status, finalUrl: next, contentHash: null, body: null,
            fetchedAt: now(), error: 'unsafe_redirect', reason: safe.reason, hops };
        }
        current = safe.url; hops.push(current);
        continue;
      }
      let body = null;
      try { body = await res.text(); } catch { body = null; }
      const ok = Boolean(res.ok ?? (status && status >= 200 && status < 300));
      return {
        ok, status, finalUrl: res.url ?? current,
        contentHash: body != null ? sha256(body) : null,
        body, fetchedAt: now(), hops,
      };
    }
    return { ok: false, status: null, finalUrl: current, contentHash: null, body: null,
      fetchedAt: now(), error: 'too_many_redirects', reason: 'redirect_loop', hops };
  }

  return { fetch: fetchUrl };
}

export default { createFetcher };
