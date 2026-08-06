// crawler-os/fetcher.js
//
// THE fetcher. SSRF-safe, rate-limited, evidence-capturing, and bounded. Every
// URL passes safeUrl first; every redirect and retry re-resolves the host and
// re-validates its IPs, closing the DNS-rebinding gap left by one-time checks.
//
// The actual network call is injected (`doFetch`) so the engine is fully testable
// offline and so the host app controls timeouts/proxies. In production pass the
// platform `fetch` through crawlerOsService.makeProductionFetcher.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { isSafeUrl, isPrivateHost } from './safeUrl.js';

const DEFAULT_RATE_MS = 250; // min gap between requests to the same host
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 5000;
const MAX_CONFIGURED_RETRIES = 3;

// Retrying is intentionally limited to statuses that commonly represent a
// transient origin or intermediary failure. The request method is checked
// separately: GrantFlow never replays adapter POSTs.
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function sha256(s) { return createHash('sha256').update(s ?? '').digest('hex'); }
function now() { return new Date().toISOString(); }

function nonNegativeInt(value, fallback, ceiling = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(0, Math.floor(value)));
}

function positiveInt(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function getHeader(res, name) {
  const fromHeaders = res?.headers?.get?.(name);
  if (fromHeaders != null) return fromHeaders;
  const entries = res?.headers && typeof res.headers === 'object'
    ? Object.entries(res.headers)
    : [];
  const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ?? null;
}

function parseContentLength(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseRetryAfter(value, clock) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - clock());
}

function isRetryableMethod(init) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

function isTransientNetworkError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return false;
  const code = error?.code ?? error?.cause?.code;
  return TRANSIENT_NETWORK_CODES.has(code);
}

async function cancelResponseBody(res) {
  try {
    if (typeof res?.body?.cancel === 'function' && !res.body.locked) {
      await res.body.cancel();
    }
  } catch {
    // Best-effort connection reuse only. The caller's primary outcome wins.
  }
}

async function readBodyBounded(res, maxResponseBytes) {
  const declaredResponseBytes = parseContentLength(getHeader(res, 'content-length'));
  if (declaredResponseBytes != null && declaredResponseBytes > maxResponseBytes) {
    await cancelResponseBody(res);
    return {
      ok: false,
      error: 'response_too_large',
      reason: 'content_length_exceeds_limit',
      responseBytes: 0,
      declaredResponseBytes,
    };
  }

  if (typeof res?.body?.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let responseBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : Buffer.from(value ?? '');
        responseBytes += chunk.byteLength;
        if (responseBytes > maxResponseBytes) {
          try { await reader.cancel(); } catch { /* best effort */ }
          return {
            ok: false,
            error: 'response_too_large',
            reason: 'body_exceeds_limit',
            responseBytes,
            declaredResponseBytes,
          };
        }
        chunks.push(chunk);
      }
      return {
        ok: true,
        body: Buffer.concat(chunks, responseBytes).toString('utf8'),
        responseBytes,
        declaredResponseBytes,
      };
    } catch (error) {
      try { await reader.cancel(); } catch { /* best effort */ }
      return {
        ok: false,
        error: 'response_body_read_failed',
        reason: String(error?.message ?? error),
        responseBytes,
        declaredResponseBytes,
      };
    }
  }

  try {
    const body = await res.text();
    const responseBytes = Buffer.byteLength(body, 'utf8');
    if (responseBytes > maxResponseBytes) {
      return {
        ok: false,
        error: 'response_too_large',
        reason: 'body_exceeds_limit',
        responseBytes,
        declaredResponseBytes,
      };
    }
    return { ok: true, body, responseBytes, declaredResponseBytes };
  } catch (error) {
    return {
      ok: false,
      error: 'response_body_read_failed',
      reason: String(error?.message ?? error),
      responseBytes: 0,
      declaredResponseBytes,
    };
  }
}

/**
 * createFetcher — build a fetcher bound to a network impl + optional DNS resolver.
 *
 * @param {object} opts
 * @param {(url:string, init?:object)=>Promise<{status:number, ok:boolean, text:()=>Promise<string>, body?:ReadableStream, url?:string, headers?:any}>} opts.doFetch
 * @param {(host:string)=>Promise<string[]>} [opts.resolve]  returns IPs for a host (DNS-rebinding guard)
 * @param {number} [opts.rateMs]
 * @param {number} [opts.maxRedirects]
 * @param {number} [opts.maxRetries] bounded retry count across the logical request; defaults off
 * @param {number} [opts.retryBaseMs]
 * @param {number} [opts.retryMaxMs]
 * @param {number} [opts.maxResponseBytes]
 * @param {()=>number} [opts.clock]  ms clock (injectable for tests)
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 */
export function createFetcher(opts = {}) {
  const doFetch = opts.doFetch;
  if (typeof doFetch !== 'function') throw new Error('createFetcher: opts.doFetch is required');
  const resolve = typeof opts.resolve === 'function'
    ? opts.resolve
    : async (host) => {
        const records = await dns.promises.lookup(host, { all: true, verbatim: true });
        return records.map((record) => record.address);
      };
  const rateMs = nonNegativeInt(opts.rateMs, DEFAULT_RATE_MS);
  const maxRedirects = nonNegativeInt(opts.maxRedirects, 4);
  const maxRetries = nonNegativeInt(opts.maxRetries, 0, MAX_CONFIGURED_RETRIES);
  const retryBaseMs = nonNegativeInt(opts.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const retryMaxMs = nonNegativeInt(opts.retryMaxMs, DEFAULT_RETRY_MAX_MS);
  const maxResponseBytes = positiveInt(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
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
    let ips = [];
    try { ips = await resolve(host); } catch (e) { return { ok: false, reason: `dns_error:${e?.code ?? e}` }; }
    if (!ips.length) return { ok: false, reason: 'dns_no_records' };
    if (ips.some((ip) => isPrivateHost(ip))) return { ok: false, reason: 'dns_resolves_private' };
    return { ok: true, ips };
  }

  /**
   * fetch — safe fetch with evidence capture and additive transport telemetry.
   * @returns {Promise<{ ok:boolean, status:number|null, finalUrl:string|null,
   *   contentHash:string|null, body:string|null, fetchedAt:string, error?:string,
   *   reason?:string, hops?:string[], attempts:number, retries:number,
   *   retryDelaysMs:number[], retrySuppressed?:string, responseBytes:number,
   *   declaredResponseBytes?:number|null, maxResponseBytes:number }>}
   */
  async function fetchUrl(url, init = {}) {
    let attempts = 0;
    let retries = 0;
    let responseBytes = 0;
    const retryDelaysMs = [];
    const telemetry = (extra = {}) => ({
      attempts,
      retries,
      retryDelaysMs: [...retryDelaysMs],
      responseBytes,
      maxResponseBytes,
      ...extra,
    });
    const failure = (fields = {}) => ({
      ok: false,
      status: null,
      finalUrl: null,
      contentHash: null,
      body: null,
      fetchedAt: now(),
      ...telemetry(),
      ...fields,
    });

    const first = isSafeUrl(url, { kind: 'fetch' });
    if (!first.ok) return failure({ error: 'unsafe_url', reason: first.reason });

    let current = first.url;
    let redirects = 0;
    const hops = [current];
    while (true) {
      const parsed = new URL(current);
      const ipGuard = await guardHostIps(parsed.hostname);
      if (!ipGuard.ok) {
        return failure({ finalUrl: current, error: 'ssrf_guard', reason: ipGuard.reason, hops });
      }
      await rateLimit(parsed.hostname);

      let res;
      attempts += 1;
      try {
        res = await doFetch(current, { ...init, redirect: 'manual' });
      } catch (error) {
        const callerAborted = Boolean(init.signal?.aborted);
        const mayRetry = isRetryableMethod(init)
          && !callerAborted
          && isTransientNetworkError(error)
          && retries < maxRetries;
        if (mayRetry) {
          const delayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** retries));
          retries += 1;
          retryDelaysMs.push(delayMs);
          if (delayMs > 0) await sleep(delayMs);
          if (!init.signal?.aborted) continue;
        }
        const retrySuppressed = callerAborted || init.signal?.aborted
          ? 'request_aborted'
          : (!isRetryableMethod(init) && isTransientNetworkError(error)
              ? 'non_idempotent_method'
              : (isTransientNetworkError(error) && retries >= maxRetries ? 'retry_limit_reached' : undefined));
        return failure({
          finalUrl: current,
          error: String(error?.message ?? error),
          reason: callerAborted || init.signal?.aborted ? 'request_aborted' : 'fetch_threw',
          hops,
          ...(retrySuppressed ? { retrySuppressed } : {}),
        });
      }

      const status = res.status ?? null;
      const retryAfterMs = parseRetryAfter(getHeader(res, 'retry-after'), clock);
      if (status != null && RETRYABLE_STATUSES.has(status)) {
        let retrySuppressed;
        if (!isRetryableMethod(init)) retrySuppressed = 'non_idempotent_method';
        else if (retries >= maxRetries) retrySuppressed = 'retry_limit_reached';
        else if (retryAfterMs != null && retryAfterMs > retryMaxMs) retrySuppressed = 'retry_after_exceeds_limit';

        if (!retrySuppressed) {
          const delayMs = retryAfterMs ?? Math.min(retryMaxMs, retryBaseMs * (2 ** retries));
          await cancelResponseBody(res);
          retries += 1;
          retryDelaysMs.push(delayMs);
          if (delayMs > 0) await sleep(delayMs);
          if (!init.signal?.aborted) continue;
          return failure({
            status,
            finalUrl: current,
            error: 'request_aborted',
            reason: 'request_aborted',
            hops,
            retrySuppressed: 'request_aborted',
          });
        }

        // The final response still goes through the bounded reader so a remote
        // cannot use an error body to bypass the resource ceiling.
        const bounded = await readBodyBounded(res, maxResponseBytes);
        responseBytes = bounded.responseBytes;
        if (!bounded.ok) {
          return failure({
            status,
            finalUrl: res.url ?? current,
            error: bounded.error,
            reason: bounded.reason,
            hops,
            retrySuppressed,
            retryAfterMs,
            declaredResponseBytes: bounded.declaredResponseBytes,
          });
        }
        return {
          ok: false,
          status,
          finalUrl: res.url ?? current,
          contentHash: sha256(bounded.body),
          body: bounded.body,
          fetchedAt: now(),
          hops,
          ...telemetry({
            retrySuppressed,
            retryAfterMs,
            declaredResponseBytes: bounded.declaredResponseBytes,
          }),
        };
      }

      // Manual redirect handling so each hop is re-validated and re-resolved.
      if (status != null && status >= 300 && status < 400) {
        const loc = getHeader(res, 'location') ?? res.location ?? null;
        await cancelResponseBody(res);
        if (!loc) {
          return failure({
            status,
            finalUrl: current,
            error: 'redirect_without_location',
            reason: 'bad_redirect',
            hops,
          });
        }
        if (redirects >= maxRedirects) {
          return failure({
            status,
            finalUrl: current,
            error: 'too_many_redirects',
            reason: 'redirect_loop',
            hops,
          });
        }
        const next = new URL(loc, current).toString();
        const safe = isSafeUrl(next, { kind: 'fetch' });
        if (!safe.ok) {
          return failure({
            status,
            finalUrl: next,
            error: 'unsafe_redirect',
            reason: safe.reason,
            hops,
          });
        }
        redirects += 1;
        current = safe.url;
        hops.push(current);
        continue;
      }

      const bounded = await readBodyBounded(res, maxResponseBytes);
      responseBytes = bounded.responseBytes;
      if (!bounded.ok) {
        return failure({
          status,
          finalUrl: res.url ?? current,
          error: bounded.error,
          reason: bounded.reason,
          hops,
          declaredResponseBytes: bounded.declaredResponseBytes,
        });
      }
      const ok = Boolean(res.ok ?? (status != null && status >= 200 && status < 300));
      return {
        ok,
        status,
        finalUrl: res.url ?? current,
        contentHash: sha256(bounded.body),
        body: bounded.body,
        fetchedAt: now(),
        hops,
        ...telemetry({ declaredResponseBytes: bounded.declaredResponseBytes }),
      };
    }
  }

  return { fetch: fetchUrl };
}

export default { createFetcher };
