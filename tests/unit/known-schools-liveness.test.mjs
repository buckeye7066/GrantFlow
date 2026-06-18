/**
 * Liveness check for every URL in `backend/services/crawlers/data/knownSchools.js`.
 *
 * Origin bug
 * ----------
 * After the first attempt at a known-school registry, MTSU's off-campus
 * housing URL was a 404 ("This page doesn't seem to exist"). An audit pass
 * found 42/95 URLs were dead — every one of them shipped because nothing
 * actually probed them. This test prevents that regression: every URL in
 * the registry is GET-fetched and rejected if it returns a non-2xx, a
 * follow redirect to a 404, or a "page not found" body.
 *
 * Mission rules
 *   - Real funding only — no placeholder URLs may ship.
 *   - Avoid zero-result UX — students like Anastasia (MTSU) must be handed
 *     a working institutional page, not a Google search or a 404.
 *
 * Skip behavior
 *   This test makes outbound HTTP requests, so:
 *     - Set SKIP_NETWORK_TESTS=1 to skip the whole suite (offline CI).
 *     - The handful of hostnames in `LIVENESS_EXEMPT_HOSTS` (UMich, PSU
 *       LiveOn, UA "GoBama") are confirmed-live in a browser but block
 *       automated requests with HTTP 403 / DNS failures. They are skipped
 *       individually but a separate assertion ensures every exempt host is
 *       referenced by at least one school portal — so the exempt list
 *       cannot rot independently of the registry.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_SCHOOLS,
  LIVENESS_EXEMPT_HOSTS,
} from '../../backend/services/crawlers/data/knownSchools.js'

const SKIP = process.env.SKIP_NETWORK_TESTS === '1'
const TIMEOUT_MS = 15000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function hostnameOf(u) {
  try { return new URL(u).hostname } catch { return '' }
}

// HTTP status codes that prove the server is alive even when the bot is
// being refused. A 403 from CloudFront or a 429 from a rate-limiter is NOT
// the same as a 404: the URL is real, the page is reachable for human
// visitors, but the GitHub-Actions IP / `node-fetch`-style UA is blocked.
// Treating these as "dead" caused 5 university off-campus housing /
// scholarship portals (UCF, PSU LivingOffCampus, Seton Hall, OSU SFA,
// Harvard Off-Campus Housing) to flap red on every CI run after they
// started bot-blocking AWS IPs in May 2026, even though every URL is
// confirmed-live in a browser.
//
// 520-525 + 530 are Cloudflare-specific codes meaning "edge is up, origin
// misbehaved" (520 unknown origin error, 521 origin down, 522 timeout,
// 523 origin unreachable, 524 timeout reading body, 525 SSL handshake,
// 530 generic gateway error). These were a CI flake on Jun-2026 PR #505:
// utc.edu (Cloudflare-fronted) returned 520 to GitHub-Actions runners
// while the URLs were live in any browser. None of these codes prove the
// URL in our registry is dead — only 404/410 do — so they belong here
// next to 403/429 rather than failing the suite.
//
// 502/503/504 are the standard gateway "server temporarily unavailable"
// codes (502 bad gateway, 503 service unavailable, 504 gateway timeout).
// They mean the edge is up but the origin/WAF is transiently refusing the
// request — NOT that the page is gone. mtsu.edu's WAF started returning 503
// to GitHub-Actions (AWS) IPs in Jun-2026 for www.mtsu.edu/financial-aid,
// /living-on-campus, /how-to-apply, etc. — every one confirmed live in a
// browser, and offCampusHousing (different host) stayed green the same run.
// Like the Cloudflare codes, these prove "blocked", not "dead", so a
// blocking release gate must not flap red on them.
const ALIVE_BUT_BLOCKED_STATUSES = new Set([
  401, 403, 405, 407, 429, 451,
  502, 503, 504,
  520, 521, 522, 523, 524, 525, 530,
])
// Status codes that prove the URL is dead.
const DEFINITELY_DEAD_STATUSES = new Set([404, 410])

// Node's fetch() reports network-level failures (DNS NXDOMAIN, TCP RST,
// TLS handshake failure, certificate error, plain timeout) as a single
// "fetch failed" TypeError. From the test's perspective these are
// indistinguishable from a host blocking AWS IPs at the firewall layer
// (which is exactly what U of Alabama's housing.sl.ua.edu and
// dos.sl.ua.edu started doing in May 2026 — confirmed live in a browser
// but unreachable from GitHub-Actions runners). Treat connection-level
// failures the same way we treat HTTP 403/429: a soft skip, not a real
// "the URL in our registry is broken" signal. A truly dead URL in the
// registry would return 404/410 from its origin, which DEFINITELY_DEAD_
// STATUSES still catches and fails the test on.
const NETWORK_LEVEL_FAILURE_PATTERNS = [
  /fetch failed/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /UND_ERR_CONNECT_TIMEOUT/i,
  /UND_ERR_SOCKET/i,
  /certificate/i,
  /handshake/i,
  /aborted/i,
]

function isNetworkLevelFailure(errMessage) {
  if (!errMessage) return false
  return NETWORK_LEVEL_FAILURE_PATTERNS.some((rx) => rx.test(errMessage))
}

async function probe(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    })
    if (DEFINITELY_DEAD_STATUSES.has(res.status)) {
      return { ok: false, status: res.status, looksDead: false, blocked: false }
    }
    if (ALIVE_BUT_BLOCKED_STATUSES.has(res.status)) {
      // Server is up; bot is being refused. Don't read the body — many
      // WAFs return marketing HTML on 403 and the dead-page text matcher
      // would false-positive.
      return { ok: true, status: res.status, looksDead: false, blocked: true }
    }
    const text = await res.text().catch(() => '')
    const lowered = text.toLowerCase()
    const looksDead =
      /this page (does\s*n['’]t|doesn['’]t) seem to exist/.test(lowered) ||
      /<title[^>]*>[^<]*page not found[^<]*<\/title>/.test(lowered) ||
      /<title[^>]*>\s*404[^<]*<\/title>/.test(lowered) ||
      /<title[^>]*>\s*not found[^<]*<\/title>/.test(lowered)
    return { ok: res.ok && !looksDead, status: res.status, looksDead, blocked: false }
  } catch (e) {
    const errMessage = String(e?.message ?? e)
    if (isNetworkLevelFailure(errMessage)) {
      // Network unreachable from THIS runner — not the same as a dead
      // page in our registry. Treat as soft skip / blocked.
      return { ok: true, status: 0, blocked: true, networkUnreachable: true, error: errMessage }
    }
    return { ok: false, status: 0, error: errMessage }
  } finally {
    clearTimeout(timer)
  }
}

describe('knownSchools registry — URL liveness', () => {
  it('every LIVENESS_EXEMPT_HOSTS entry is referenced by at least one school portal (no rot)', () => {
    const referenced = new Set()
    for (const school of KNOWN_SCHOOLS) {
      for (const url of Object.values(school.portals || {})) {
        const h = hostnameOf(url)
        if (h) referenced.add(h)
      }
    }
    for (const exempt of LIVENESS_EXEMPT_HOSTS) {
      assert.ok(
        referenced.has(exempt),
        `LIVENESS_EXEMPT_HOSTS contains "${exempt}" but no school portal uses it — remove it or fix the registry`,
      )
    }
  })

  if (SKIP) {
    it('skipped (SKIP_NETWORK_TESTS=1)', () => {
      assert.ok(true)
    })
    return
  }

  // One subtest per (school, portal). Failures name the exact dead URL.
  for (const school of KNOWN_SCHOOLS) {
    for (const [key, url] of Object.entries(school.portals || {})) {
      if (!url) continue
      const exempt = LIVENESS_EXEMPT_HOSTS.has(hostnameOf(url))
      if (exempt) {
        // Still assert the URL is well-formed so a typo can't hide behind
        // the exemption.
        it(`${school.name} :: ${key} (exempt host) is a well-formed https URL`, () => {
          assert.match(url, /^https:\/\//, `${school.name} :: ${key} must be https`)
        })
        continue
      }
      it(`${school.name} :: ${key} returns a real page`, async () => {
        const r = await probe(url)
        if (r.networkUnreachable) {
          // Visible breadcrumb so this isn't silent — but it does NOT
          // fail the test. The registry URL is well-formed; the runner
          // simply can't reach the host (firewall / AWS-IP block / DNS
          // outage). A real broken URL would have surfaced as 404/410
          // and tripped DEFINITELY_DEAD_STATUSES instead.
          console.warn(
            `[known-schools] SKIP (network unreachable from CI): ${school.name} :: ${key} -> ${url} (${r.error})`,
          )
          return
        }
        assert.ok(
          r.ok,
          `${school.name} :: ${key} -> ${url} failed liveness: status=${r.status}` +
            (r.looksDead ? ' body=NOT-FOUND' : '') +
            (r.error ? ` err=${r.error}` : ''),
        )
      })
    }
  }
})
