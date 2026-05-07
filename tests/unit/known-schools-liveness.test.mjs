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
    const text = await res.text().catch(() => '')
    const lowered = text.toLowerCase()
    const looksDead =
      /this page (does\s*n['’]t|doesn['’]t) seem to exist/.test(lowered) ||
      /<title[^>]*>[^<]*page not found[^<]*<\/title>/.test(lowered) ||
      /<title[^>]*>\s*404[^<]*<\/title>/.test(lowered) ||
      /<title[^>]*>\s*not found[^<]*<\/title>/.test(lowered)
    return { ok: res.ok && !looksDead, status: res.status, looksDead }
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message ?? e) }
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
