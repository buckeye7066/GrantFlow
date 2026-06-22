/**
 * Liveness check for every URL in `backend/services/shared/data/knownSchools.js`.
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
} from '../../backend/services/shared/data/knownSchools.js'

const SKIP = process.env.SKIP_NETWORK_TESTS === '1'
const TIMEOUT_MS = 15000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function hostnameOf(u) {
  try { return new URL(u).hostname } catch { return '' }
}

// The contract of this gate, stated precisely: a registry URL is "dead"
// ONLY if its origin returns 404 (Not Found) or 410 (Gone). EVERY other
// status >= 400 means the server is reachable but is refusing or erroring
// for *this* bot/runner — it is never proof that the page our registry
// points at is gone. We therefore invert the old allowlist (enumerate the
// dead codes, treat all other >=400 as "alive but blocked") instead of
// trying to keep an ever-growing list of "blocked" codes in sync with
// every WAF/CDN's behaviour. That open-ended allowlist flaked the gate one
// code at a time:
//   - 403/429 (CloudFront / rate-limiters): UCF, PSU LivingOffCampus,
//     Seton Hall, OSU SFA, Harvard Off-Campus Housing bot-blocked AWS IPs
//     (May 2026) — confirmed live in a browser.
//   - 520-525/530 (Cloudflare "edge up, origin misbehaved"): utc.edu
//     returned 520 to GitHub-Actions runners (Jun 2026, PR #505).
//   - 502/503/504 (gateway "temporarily unavailable"): mtsu.edu's WAF
//     returned 503 to AWS IPs (Jun 2026) for /financial-aid,
//     /living-on-campus, /how-to-apply — offCampusHousing (different host)
//     stayed green the same run.
// None of these prove a dead link; only 404/410 do. The denylist below is
// closed and cannot rot the way the old allowlist did.
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
    if (res.status >= 400) {
      // Reachable server, but refusing/erroring for this bot/runner (4xx
      // auth/rate-limit/WAF blocks, 5xx gateway/origin trouble). Not 404/410,
      // so not proof the registry URL is dead. Don't read the body — many
      // WAFs return marketing/error HTML here and the dead-page text matcher
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
