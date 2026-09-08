/**
 * The catalog re-score sweep wrote ACCEPT rows with no four_truth_proof, and
 * `enforcePersistedMatchDecisionIntegrity` deleted every one later in the SAME
 * boot (its counter is `removed_unproven_direct_accepts`). Proven by running
 * all 70 enforcers in sequence over a live 32-row lane: 32 -> 0, nothing else
 * touched them.
 *
 * No shortcut is honest: measured over all 20,407 active non-pointer catalog
 * rows, content hash coverage is ZERO, so no row can support a REAL leg from
 * stored state, and `refreshFourTruthProof` refuses to manufacture one.
 * Publishing "real funding you can apply to" requires actually reading the
 * page. These tests pin that the capture reports EVIDENCE, never a verdict,
 * and that it can never invent a passing leg.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  captureRealityEvidence,
  realLegFromCapture,
  captureTargetUrl,
} from '../services/matching/rescoreRealityCapture.js'

const row = (over = {}) => ({
  id: 'opp-1',
  reality_status: 'VERIFIED',
  apply_url: 'https://funder.example.org/apply',
  ...over,
})

const fetcherReturning = (res) => ({ fetch: vi.fn(async () => res) })

describe('captureTargetUrl — the page an applicant would actually open', () => {
  it('prefers apply_url, because apply_url IS an apply target (#1601)', () => {
    expect(captureTargetUrl(row({ source_url: 'https://listing.example/all' })))
      .toBe('https://funder.example.org/apply')
  })

  it('falls back through application_url and only lastly to a listing source_url', () => {
    expect(captureTargetUrl({ application_url: 'https://a.example/x' })).toBe('https://a.example/x')
    expect(captureTargetUrl({ source_url: 'https://listing.example/all' })).toBe('https://listing.example/all')
  })

  it('returns null when the row names no target at all', () => {
    expect(captureTargetUrl({})).toBeNull()
    expect(captureTargetUrl({ apply_url: '   ' })).toBeNull()
  })
})

describe('captureRealityEvidence — evidence, never a verdict', () => {
  it('captures a content hash and capture time from a real read', async () => {
    const f = fetcherReturning({
      ok: true, status: 200, finalUrl: 'https://funder.example.org/apply',
      contentHash: 'sha256:abc', fetchedAt: '2026-09-08T05:00:00.000Z', body: '<html>Apply</html>',
    })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.captured).toBe(true)
    expect(r.contentHash).toBe('sha256:abc')
    expect(r.fetchedAt).toBe('2026-09-08T05:00:00.000Z')
    expect(r.transient).toBe(false)
  })

  it('records the FINAL url — a redirect means the evidence belongs where we landed', async () => {
    const f = fetcherReturning({
      ok: true, status: 200, finalUrl: 'https://funder.example.org/apply/2026',
      contentHash: 'sha256:abc', fetchedAt: '2026-09-08T05:00:00.000Z',
    })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.evidenceUrl).toBe('https://funder.example.org/apply/2026')
  })

  // THE MASS-BURN CLASS: 401/403/429 refuses OUR egress, not the URL. Treating
  // it as a fact about the row is how this repo previously burned 34 rows in 5s.
  it.each([401, 403, 429])('treats %i as an ENVIRONMENT fact, never a fact about the row', async (status) => {
    const f = fetcherReturning({ ok: false, status })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.environment).toBe(true)
    expect(r.transient).toBe(true)
    expect(r.captured).toBe(false)
  })

  it.each([500, 503, 408, null])('treats %s as transient — an outage never burns a row', async (status) => {
    const f = fetcherReturning({ ok: false, status })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.transient).toBe(true)
    expect(r.environment).toBe(false)
  })

  it('treats a stable 404 as a REAL answer about the row, not a retryable blip', async () => {
    const f = fetcherReturning({ ok: false, status: 404 })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.transient).toBe(false)
    expect(r.captured).toBe(false)
    expect(r.reason).toBe('page_gone')
  })

  it('never captures for a row the reality gate already rejected or expired', async () => {
    const f = fetcherReturning({ ok: true, status: 200, contentHash: 'sha256:abc', fetchedAt: 'now' })
    for (const status of ['REJECTED', 'EXPIRED', 'DOWNGRADED']) {
      const r = await captureRealityEvidence(row({ reality_status: status }), { fetcher: f })
      expect(r.captured).toBe(false)
      expect(f.fetch).not.toHaveBeenCalled()
    }
  })

  it('a row with no target URL is not attempted', async () => {
    const f = fetcherReturning({ ok: true, contentHash: 'x' })
    const r = await captureRealityEvidence({ reality_status: 'VERIFIED' }, { fetcher: f })
    expect(r.attempted).toBe(false)
    expect(r.reason).toBe('no_url')
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('a throwing fetcher is transient and never fails the run', async () => {
    const f = { fetch: vi.fn(async () => { throw new Error('socket hang up') }) }
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.transient).toBe(true)
    expect(r.captured).toBe(false)
  })

  it('a 200 with NO content hash is not a capture — the hash IS the proof', async () => {
    const f = fetcherReturning({ ok: true, status: 200, contentHash: null, fetchedAt: 'now' })
    const r = await captureRealityEvidence(row(), { fetcher: f })
    expect(r.captured).toBe(false)
  })
})

describe('realLegFromCapture — cannot invent a passing leg', () => {
  it('builds a REAL leg that satisfies the four-truth contract from a real capture', async () => {
    const leg = realLegFromCapture(row(), {
      captured: true, contentHash: 'sha256:abc',
      fetchedAt: '2026-09-08T05:00:00.000Z', evidenceUrl: 'https://funder.example.org/apply',
    })
    expect(leg.passed).toBe(true)
    expect(leg.content_hash_present).toBe(true)
    expect(leg.evidence_captured_at).toBe('2026-09-08T05:00:00.000Z')
    expect(leg.evidence_url).toBe('https://funder.example.org/apply')
  })

  // The whole point: no capture => no publication. Manufacturing a leg here is
  // exactly the fabrication refreshFourTruthProof refuses to perform.
  it.each([
    ['nothing captured', { captured: false, contentHash: 'sha256:abc' }],
    ['captured but hashless', { captured: true, contentHash: null }],
    ['undefined', undefined],
  ])('returns null for %s, so the caller cannot publish', (_label, capture) => {
    expect(realLegFromCapture(row(), capture)).toBeNull()
  })

  it('the leg it builds is accepted by the real four-truth predicate', async () => {
    const { refreshFourTruthProof } = await import('../crawler-os/fundingTruthPolicy.js')
    const { hasPositiveFourTruthProof } = await import('../crawler-os/fundingTruthPolicy.js')
    const real = realLegFromCapture(row(), {
      captured: true, contentHash: 'sha256:abc',
      fetchedAt: '2026-09-08T05:00:00.000Z', evidenceUrl: 'https://funder.example.org/apply',
    })
    // Hand the fresh REAL leg in as the "previous" proof: refreshFourTruthProof
    // carries REAL verbatim and recomputes the other three from the canonical
    // decision, so the sweep reuses the existing authority instead of forking it.
    const proof = refreshFourTruthProof(
      { four_truth_proof: { direct_funding: true, real } },
      {
        // NOTE the shape: `applicantMatched` is read from
        // canonical.match_explain.matchedSignals, NOT the top level — which is
        // also how computeMatchDecision actually returns it, so the sweep must
        // hand the decision through unflattened.
        canonical: {
          decision: 'ACCEPT', score: 52, eligible: 'yes',
          match_explain: { matchedNeeds: ['housing'], matchedSignals: ['applicant_type'] },
        },
        opportunity: { applicant_types: ['individual'], eligibility_text: 'Open to individual homeowners.' },
        needsDefaulted: false,
        refreshedBy: 'catalog_rescore_capture',
      },
    )
    expect(proof).not.toBeNull()
    expect(proof.real.content_hash_present).toBe(true)
    expect(hasPositiveFourTruthProof({ match_explain: { four_truth_proof: proof } })).toBe(true)
  })
})
