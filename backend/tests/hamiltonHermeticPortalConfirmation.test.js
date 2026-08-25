import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const temporaryRoots = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function captureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-confirmation-contract-'))
  temporaryRoots.push(root)
  return root
}

function hermeticPage({ url, body = '', html = null }) {
  return {
    url: () => url,
    locator: (selector) => {
      expect(selector).toBe('body')
      return { innerText: async () => body }
    },
    content: async () => html ?? `<!doctype html><html><body>${body}</body></html>`,
    screenshot: async ({ path: screenshotPath, fullPage }) => {
      expect(fullPage).toBe(true)
      fs.writeFileSync(screenshotPath, 'hermetic screenshot fixture')
    },
  }
}

describe('Hamilton hermetic portal-family confirmation contract', () => {
  it.each([
    {
      family: 'labelled confirmation number',
      page: {
        url: 'https://portal.example.org/applications/complete',
        body: 'Application received. Confirmation number: GF-2026-10482',
      },
      reference: 'GF-2026-10482',
    },
    {
      family: 'confirmation query token',
      page: {
        url: 'https://portal.example.org/complete?confirmationId=QUERY-80210',
        body: 'Submission complete.',
      },
      reference: 'QUERY-80210',
    },
    {
      family: 'receipt path token',
      page: {
        url: 'https://portal.example.org/receipt/PATH-99172',
        body: 'Thank you.',
      },
      reference: 'PATH-99172',
    },
  ])('captures durable reference proof for $family portals', async ({ page, reference }) => {
    const capture = await _internal.captureConfirmation(hermeticPage(page), captureRoot())
    const evidence = _internal.assessSubmissionEvidence(capture, {
      url: 'https://portal.example.org/application/form',
      reference: null,
      received_acknowledgement: false,
    })
    const result = _internal.submitCaptureResult(capture, {}, evidence)

    expect(capture.reference).toBe(reference)
    expect(evidence).toEqual({ ok: true, confirmation_evidence: 'portal_reference' })
    expect(result.submission_evidence_classification).toBe('confirmation_proof')
    expect(result.confirmation_reference_is_new).toBe(true)
    expect(fs.existsSync(capture.screenshot_path)).toBe(true)
    expect(fs.existsSync(capture.page_html_path)).toBe(true)
  })

  it('accepts a newly observed receipt acknowledgement without inventing a reference', async () => {
    const before = {
      url: 'https://portal.example.org/application/form',
      reference: null,
      received_acknowledgement: false,
    }
    const capture = await _internal.captureConfirmation(hermeticPage({
      url: 'https://portal.example.org/thank-you',
      body: 'Thank you for your submission. We have received your application.',
    }), captureRoot())
    const evidence = _internal.assessSubmissionEvidence(capture, before)

    expect(capture.reference).toBeNull()
    expect(capture.received_acknowledgement).toBe(true)
    expect(evidence).toEqual({ ok: true, confirmation_evidence: 'portal_acknowledgement' })
    expect(_internal.submitCaptureResult(capture, before, evidence)).toMatchObject({
      submission_evidence_classification: 'confirmation_proof',
      confirmation_reference: null,
      confirmation_received_acknowledgement_is_new: true,
      confirmation_url_changed: true,
    })
  })

  it.each([
    {
      caseName: 'unchanged acknowledgement',
      before: {
        url: 'https://portal.example.org/application/form',
        received_acknowledgement: true,
      },
      page: {
        url: 'https://portal.example.org/application/form',
        body: 'Thank you for your submission.',
      },
    },
    {
      caseName: 'DOM slug that resembles a labelled code',
      before: { url: 'https://portal.example.org/application/form' },
      page: {
        url: 'https://portal.example.org/application/form',
        body: 'Confirmation #: children-notification-children-notification',
      },
    },
    {
      caseName: 'artifact-only click attempt',
      before: { url: 'https://portal.example.org/application/form' },
      page: {
        url: 'https://portal.example.org/application/form',
        body: 'Your application is ready to submit.',
      },
    },
  ])('keeps $caseName out of the externally submitted state', async ({ before, page }) => {
    const capture = await _internal.captureConfirmation(hermeticPage(page), captureRoot())
    const evidence = _internal.assessSubmissionEvidence(capture, before)
    const result = _internal.submitCaptureResult(capture, before, evidence)

    expect(evidence.ok).toBe(false)
    expect(evidence.confirmation_evidence).toBe('attempt_evidence')
    expect(result.submission_evidence_classification).toBe('attempt_evidence')
    expect(result.confirmation_reference).toBeNull()
    expect(fs.existsSync(capture.screenshot_path)).toBe(true)
    expect(fs.existsSync(capture.page_html_path)).toBe(true)
  })
})
