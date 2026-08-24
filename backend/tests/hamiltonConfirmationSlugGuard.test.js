import { describe, it, expect } from 'vitest'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { extractConfirmationReference, extractConfirmationReferenceFromUrl } = _internal

// PROD EVIDENCE, 2026-08-24. Across 3,292 hamilton_autopilot_runs the database
// held exactly THREE non-null confirmation_reference values, and all three were
// the same string:
//
//   children-notification-children-notification
//
// It is a scraped DOM token (an element id, captured twice), not a
// portal-issued reference — and it sat on one run marked 'submitted' AND on two
// runs marked 'failed', which is itself proof it does not describe a submission
// outcome. Because a confirmation reference on a submitted run is one of the
// things assessStoredConfirmationProof accepts as durable proof, this single
// bogus value is the difference between "we have never confirmed a submission"
// and a surface reporting one. A FALSE proof is worse than no proof.
//
// Root cause: isPlausibleConfirmationReference rejected a single all-lowercase
// word (/^[a-z]+$/) but not several joined by hyphens, and the explicit path
// does not require a digit (deliberately — a digitless ALL-CAPS id is real).
describe('confirmation reference: a DOM slug is never a submission reference', () => {
  const SLUGS = [
    'children-notification-children-notification', // the verbatim prod value
    'skip-to-main-content',
    'privacy-policy',
    'main-content-wrapper',
  ]

  for (const slug of SLUGS) {
    it(`REJECTS the lowercase hyphen slug "${slug}" from labelled text`, () => {
      expect(extractConfirmationReference(`Confirmation number: ${slug}`)).toBeNull()
    })

    it(`REJECTS the lowercase hyphen slug "${slug}" from a confirmation URL`, () => {
      expect(
        extractConfirmationReferenceFromUrl(`https://portal.example.org/apply?confirmationId=${slug}`),
      ).toBeNull()
    })
  }

  // The guard must stay NARROW. These are real reference shapes and must survive
  // — a guard that also eats them would trade a false positive for a false
  // negative, losing the proof of a submission that genuinely happened.
  const REAL = [
    ['Confirmation number: ABC-12345', 'ABC-12345'],
    ['Reference #: 2026-APP-4471', '2026-APP-4471'],
    ['Confirmation number: CONFIRMNO', 'CONFIRMNO'],   // digitless ALL-CAPS id
    ['Application ID: A1B2C3D4', 'A1B2C3D4'],
  ]
  for (const [text, expected] of REAL) {
    it(`KEEPS the real reference ${expected}`, () => {
      expect(extractConfirmationReference(text)).toBe(expected)
    })
  }

  it('KEEPS a real reference carried in a confirmation URL', () => {
    expect(
      extractConfirmationReferenceFromUrl('https://portal.example.org/apply?confirmationId=SUB-99213'),
    ).toBe('SUB-99213')
  })
})
